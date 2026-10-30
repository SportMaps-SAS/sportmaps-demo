import { useState, useEffect, useMemo } from 'react';
import { mensajeErrorDeMonto } from '@/lib/paymentAmountError';
import { todayColombia } from '@/lib/dateUtils';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { CreditCard, Building2, Smartphone, Loader2, CheckCircle2, XCircle, Info, Clock, AlertTriangle, Globe, Download, Maximize2, Percent, Copy } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { useNavigate } from 'react-router-dom';

const formatCurrency = (amount: number) =>
  new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(amount);

import { FileUpload } from '@/components/common/FileUpload';
import type { ReceiptValidationResult } from '@/hooks/useReceiptValidator';
import { calcEarlyPaymentDiscount, earlyDiscountAppliesToCategory, hasEarlierUnpaidPayment, type EarlyPaymentDiscountConfig } from '@/lib/earlyPaymentDiscount';

/** Intenta parsear un string como JSON; devuelve null si no es JSON valido. */
function safeParseJson(s: string): unknown | null {
  try { return JSON.parse(s); } catch { return null; }
}
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { BillingDetailsForm } from '@/components/billing/BillingDetailsForm';
import { useSchoolInvoicingActive, mustAskBillingData } from '@/hooks/useSchoolInvoicingActive';
import { getPaymentPayload, SchoolAthlete } from '@/lib/athleteUtils';
import { useWompiCheckout, type ServerQuote } from '@/hooks/useWompiCheckout';
import { blockPwaReload, unblockPwaReload } from '@/pwa/reloadGuard';
import MercadoPagoBrick from '@/components/checkout/MercadoPagoBrick';
import { resolvePaymentAccounts, resolvePaymentLink, accountDisplayLabel, existingChargeInfo, type PaymentChargeCategory } from '@/lib/payment-accounts';
import { definicionDeMotivo } from '@/lib/motivosDeCobro';
import { parseOpciones, precioDeServicio } from '@/lib/preciosDeServicio';
import {
  camposDeCategoria,
  conceptoDeServicios,
  conceptoDisponible,
  conceptoInicial,
  esConceptoDeCarrito,
  itemDeServicio,
  lineasDeServicio,
  motivoDelConcepto,
  opcionInicial,
  opcionesDeCheckout,
  primeraQueResponda,
  tipoDeServicioDe,
  tiposConItems,
  totalDeServicios,
  type ConceptoCheckout,
  type ConceptoInicial,
  type ItemDeServicio,
  type SeleccionDeServicios,
} from '@/components/payment/checkoutConcepto';
import { PaymentLinkButton } from '@/components/payment/PaymentLinkButton';
import type { MpCreatePaymentResult } from '@/lib/api/mercadopago';
import { autoEvaluate as autoEvaluateGlosa } from '@/lib/api/glosas';
import {
  useNextUnpaidPeriod,
  fetchPeriodStatus,
  isPeriodActive,
  type PeriodStatus,
} from '@/hooks/usePaymentPeriod';

interface MerchItemOption {
  id: string;
  name: string;
  price: number;
  size_options: string | null;
}

interface PaymentCheckoutModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  studentId: string;
  schoolId: string;
  paymentId?: string;
  teamId?: string;
  childId?: string;
  childName?: string;
  branchId?: string;
  amount: number;
  concept: string;
  mode?: 'create' | 'update';
  /**
   * Motivo preseleccionado (mode='create'): cualquier motivo del catálogo
   * (lib/motivosDeCobro.ts), p. ej. 'articulos' del botón «Agregar artículos»
   * o el `?motivo=` de un enlace de cobro. Si la escuela no lo ofrece, abre en
   * su equivalente o en la mensualidad (ver checkoutConcepto.conceptoDisponible).
   */
  initialConceptType?: ConceptoInicial;
  /**
   * mode='update': `payments.payment_category` del cobro que se paga, si quien
   * abre el modal ya la tiene. Si no viene, el modal la lee de la fila. Decide si
   * es un cobro ÚNICO (inscripción, seguro… — ver isOneTimeCategory).
   */
  paymentCategory?: string | null;
  /**
   * Medios que acepta quien cobra (claves: wompi, nequi, daviplata, breb,
   * transferencia, efectivo). Hoy solo lo manda la inscripción a un torneo
   * (events.payment_methods). Sin valor o vacío = todos, como siempre.
   */
  allowedMethods?: string[] | null;
  /**
   * Método con el que abre. «Ya transferí: subir el comprobante» pide
   * 'transfer': abrir con «Pagar online» marcado obligaba a cambiarlo a mano.
   * Sin valor: Wompi si la escuela lo tiene, si no transferencia (como siempre).
   */
  initialMethod?: 'transfer';
  onSuccess?: () => void;
}

export function PaymentCheckoutModal({
  open, onOpenChange, studentId, schoolId, paymentId, teamId, childId, childName, branchId, amount, concept, mode = 'update', initialConceptType, paymentCategory: paymentCategoryProp, allowedMethods, initialMethod, onSuccess
}: PaymentCheckoutModalProps) {
  const [selectedMethod, setSelectedMethod] = useState<'pse' | 'card' | 'transfer' | 'online' | 'mercadopago' | null>(null);
  const [mpReference, setMpReference] = useState<string>('');
  const [wompiEnabled, setWompiEnabled] = useState(false);
  // Restricción por medios aceptados (torneos). Sin lista = sin restricción.
  const restringe = !!allowedMethods && allowedMethods.length > 0;
  const permiteOnline = !restringe || allowedMethods!.includes('wompi');
  const permiteTransfer = !restringe
    || allowedMethods!.some((k) => ['nequi', 'daviplata', 'breb', 'transferencia'].includes(k));
  // true cuando ya se leyó school_settings: recién ahí se sabe qué método preseleccionar.
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [onlineFeePct, setOnlineFeePct] = useState(3);
  const [allowInstallments, setAllowInstallments] = useState(false);
  const [minInstallmentAmount, setMinInstallmentAmount] = useState(0);
  const [proofUrl, setProofUrl] = useState<string | null>(null);
  // Resultado del OCR del comprobante manual. Se persiste en el pago para que
  // el admin vea el monto detectado y la alerta de discrepancia en Cobros por
  // Aprobar (igual que el flujo QR / ParentCheckoutPage).
  const [ocrResult, setOcrResult] = useState<ReceiptValidationResult | null>(null);
  const [processing, setProcessing] = useState(false);
  const [paymentStatus, setPaymentStatus] = useState<'idle' | 'processing' | 'success' | 'error' | 'awaiting_approval'>('idle');

  // Custom Payment Fields
  // «Tipo de Pago» (mode='create'). Las opciones salen del catálogo único de
  // motivos (checkoutConcepto.opcionesDeCheckout).
  const [conceptType, setConceptType] = useState<ConceptoCheckout>(() => conceptoInicial(initialConceptType, amount));
  const [customAmount, setCustomAmount] = useState((amount || 0).toString());
  const [customConcept, setCustomConcept] = useState('');

  // ── Artículos escolares (Fase 3, docs/specs/articulos-escolares-catalogo.md) ──
  // Catálogo propio de la escuela, ajeno a mensualidad/inscripción — genera su
  // propia fila de pago (payment_category='articulos'), nunca se funde con las
  // otras. Solo se carga/muestra en mode='create'.
  const [merchEnabled, setMerchEnabled] = useState(false);
  const [merchCatalog, setMerchCatalog] = useState<MerchItemOption[]>([]);
  const [merchSelected, setMerchSelected] = useState<Record<string, { qty: number; size: string | null }>>({});
  const [merchLoaded, setMerchLoaded] = useState(false);

  useEffect(() => {
    if (!open || !schoolId || mode !== 'create') return;
    (async () => {
      const { data: settings } = await supabase.from('school_settings')
        .select('merchandise_enabled').eq('school_id', schoolId).maybeSingle();
      const enabled = !!(settings as any)?.merchandise_enabled;
      setMerchEnabled(enabled);
      if (!enabled) { setMerchCatalog([]); setMerchLoaded(true); return; }
      const { data: items } = await supabase.from('school_merchandise_items' as any)
        .select('id, name, price, size_options')
        .eq('school_id', schoolId).eq('active', true)
        .order('sort_order', { ascending: true });
      setMerchCatalog((items as any) || []);
      setMerchLoaded(true);
    })();
  }, [open, schoolId, mode]);

  function toggleMerchItem(item: MerchItemOption) {
    setMerchSelected((prev) => {
      const next = { ...prev };
      if (next[item.id]) delete next[item.id];
      else next[item.id] = { qty: 1, size: item.size_options ? item.size_options.split(',')[0].trim() : null };
      return next;
    });
  }

  function setMerchQty(itemId: string, qty: number) {
    setMerchSelected((prev) => prev[itemId] ? { ...prev, [itemId]: { ...prev[itemId], qty: Math.max(1, qty) } } : prev);
  }

  const merchTotal = merchCatalog.reduce((sum, it) => {
    const sel = merchSelected[it.id];
    return sel ? sum + it.price * sel.qty : sum;
  }, 0);

  const merchConceptText = merchCatalog
    .filter((it) => merchSelected[it.id])
    .map((it) => {
      const sel = merchSelected[it.id];
      const talla = sel?.size ? ` talla ${sel.size}` : '';
      return `${it.name}${talla} x${sel?.qty}`;
    })
    .join(', ');

  // ── Catálogo de servicios (school_tournament_items, 20260908152538) — mismo
  // patrón que artículos, sin tallas. Antes todo ítem salía bajo «Torneos» y se
  // cobraba como 'torneo' (bug L8 del plan B4): ahora cada tipo (`kind`) es su
  // propia opción y el cobro va con su categoría, un solo tipo por pago.
  const [tournEnabled, setTournEnabled] = useState(false);
  const [tournCatalog, setTournCatalog] = useState<ItemDeServicio[]>([]);
  const [tournSelected, setTournSelected] = useState<SeleccionDeServicios>({});
  const [tournLoaded, setTournLoaded] = useState(false);

  useEffect(() => {
    if (!open || !schoolId || mode !== 'create') return;
    (async () => {
      const { data: settings } = await supabase.from('school_settings')
        .select('tournament_charges_enabled').eq('school_id', schoolId).maybeSingle();
      const enabled = !!(settings as any)?.tournament_charges_enabled;
      setTournEnabled(enabled);
      if (!enabled) { setTournCatalog([]); setTournLoaded(true); return; }
      // Columnas que quizás todavía no existen (migración sin aplicar → 400):
      // los precios de M2 (comprobantes_con_motivo), `kind` (F0, 20261007095911)
      // y `event_id` (20261020122827). Se piden de la más nueva a la de siempre.
      // Un cobro vinculado a un torneo (event_id) se paga inscribiendo, no como cobro suelto.
      const pedir = (cols: string, sinTorneo: boolean) => () => {
        const q = supabase.from('school_tournament_items' as any)
          .select(cols)
          .eq('school_id', schoolId).eq('active', true)
          .order('sort_order', { ascending: true });
        return sinTorneo ? q.is('event_id', null) : q;
      };
      const items = await primeraQueResponda<Record<string, unknown>[]>([
        pedir('id, name, price, kind, precio_afiliado, precios_por_fecha, opciones', true),
        pedir('id, name, price, kind', true),
        pedir('id, name, price', true),
        pedir('id, name, price', false),
      ] as any);
      setTournCatalog((items ?? []).map(itemDeServicio));
      setTournLoaded(true);
    })();
  }, [open, schoolId, mode]);

  function toggleTournItem(item: ItemDeServicio) {
    setTournSelected((prev) => {
      const next = { ...prev };
      if (next[item.id]) delete next[item.id];
      else next[item.id] = { qty: 1, opcion: opcionInicial(item) };
      return next;
    });
  }

  function setTournQty(itemId: string, qty: number) {
    setTournSelected((prev) => prev[itemId] ? { ...prev, [itemId]: { ...prev[itemId], qty: Math.max(1, qty) } } : prev);
  }

  function setTournOpcion(itemId: string, opcion: string) {
    setTournSelected((prev) => prev[itemId] ? { ...prev, [itemId]: { ...prev[itemId], opcion } } : prev);
  }

  // Quien paga en la app ya es del club (acudiente de un deportista o
  // deportista adulto): paga el precio de afiliado del servicio, el mismo que
  // el bot le da a un celular reconocido. `hoy` decide el precio por fecha.
  const serviceType = tipoDeServicioDe(conceptType);
  const serviceItems = useMemo(
    () => (serviceType ? tournCatalog.filter((it) => it.kind === serviceType) : []),
    [tournCatalog, serviceType],
  );
  const hoyBogota = todayColombia();
  const serviceLines = lineasDeServicio(tournCatalog, tournSelected, serviceType, { afiliado: true, hoy: hoyBogota });
  const tournTotal = totalDeServicios(serviceLines);

  // Opciones de «Tipo de Pago»: los motivos del catálogo que la escuela ofrece.
  const conceptOptions = opcionesDeCheckout({
    conceptoMensualidad: concept,
    montoPlan: amount,
    permiteAbonos: allowInstallments,
    hayArticulos: merchEnabled && merchCatalog.length > 0,
    tiposDeServicio: tournEnabled ? tiposConItems(tournCatalog) : [],
  });

  // Motivo preseleccionado (enlace de cobro): se aplica al abrir; ya leídos los
  // ajustes y los catálogos, si la escuela no lo ofrece pasa a su equivalente o
  // a la mensualidad, para no dejar elegido algo que no se puede pagar.
  useEffect(() => {
    if (open && mode === 'create' && initialConceptType) setConceptType(conceptoInicial(initialConceptType, amount));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- solo al abrir o si cambia el motivo pedido
  }, [open, mode, initialConceptType]);
  const catalogsReady = settingsLoaded && merchLoaded && tournLoaded;
  useEffect(() => {
    if (!open || mode !== 'create' || !catalogsReady) return;
    setConceptType((c) => conceptoDisponible(c, conceptOptions));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- las opciones quedan fijas una vez cargado todo
  }, [open, mode, catalogsReady]);

  const [checkingPending, setCheckingPending] = useState(false);
  const [pendingPaymentDate, setPendingPaymentDate] = useState<string | null>(null);
  const { toast } = useToast();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [hasCompleteDianData, setHasCompleteDianData] = useState<boolean>(true);
  const [checkingDian, setCheckingDian] = useState<boolean>(true);
  // Datos fiscales: solo si la escuela factura electrónicamente (addon
  // 'invoicing' + facturador activo). Sin saberlo todavía se piden, como antes.
  const { active: schoolInvoicingActive } = useSchoolInvoicingActive(open ? schoolId : null);
  const dianDataOk = !mustAskBillingData(hasCompleteDianData, schoolInvoicingActive);
  const [bankDetails, setBankDetails] = useState<any>(null);
  const [showFullQr, setShowFullQr] = useState(false);

  // Montos que devolvió `create-session`. Mandan sobre los que estima este componente:
  // el Widget cobra SIEMPRE el gross del servidor, así que si difieren mostramos el suyo
  // y pedimos confirmar de nuevo en vez de cobrar algo distinto a lo que el padre aceptó.
  const [serverQuote, setServerQuote] = useState<ServerQuote | null>(null);
  // Cobro creado por este modal en modo 'create', para no duplicarlo si se reintenta.
  const [createdPaymentId, setCreatedPaymentId] = useState<string | null>(null);

  const [discountConfig, setDiscountConfig] = useState<EarlyPaymentDiscountConfig>({ enabled: false, days: 5, percentage: 0 });
  const [paymentCreatedAt, setPaymentCreatedAt] = useState<string | null>(null);
  const [alreadyAppliedDiscount, setAlreadyAppliedDiscount] = useState<number | null>(null);
  const [hasEarlierUnpaid, setHasEarlierUnpaid] = useState(false);

  // ── Cobro ÚNICO existente (mode='update') ────────────────────────────────
  // Inscripción, seguro, artículos… que la escuela ya creó (p.ej. el alta de
  // Dreamers 2026-10-10: mensualidad + inscripción + seguro). Sin esto el modal
  // lo trataba como mensualidad (conceptType arranca en 'mensualidad'):
  //   · buscaba el «siguiente mes por pagar» y, si la mensualidad de ese mes ya
  //     estaba en validación o pagada, BLOQUEABA el pago del seguro con «Ya
  //     existe un pago activo para Octubre 2026»;
  //   · le aplicaba el descuento por pronto pago (exclusivo de mensualidad);
  //   · el título decía «Mensualidad Octubre 2026».
  // La categoría sale de la prop o de la fila (payment_category); el concepto
  // solo se usa para elegir las llaves (only_for), como antes.
  const [rowCategory, setRowCategory] = useState<string | null>(null);
  const existingCharge = existingChargeInfo(mode, paymentCategoryProp ?? rowCategory, concept);
  const isExistingOneTime = existingCharge.isOneTime;
  const existingChargeLabel = existingCharge.label;

  // Mientras el modal de pago esté abierto, bloqueamos la auto-recarga del PWA:
  // si un SW nuevo toma control justo cuando el usuario ya subió el comprobante,
  // el reload borraría todo. La recarga queda pendiente y se aplica al cerrar.
  useEffect(() => {
    if (!open) return;
    blockPwaReload();
    return () => unblockPwaReload();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (mode === 'update' && paymentId) {
      supabase.from('payments')
        .select('created_at, early_payment_discount_applied, child_id, parent_id, payment_category')
        .eq('id', paymentId).maybeSingle()
        .then(async ({ data }) => {
          if (!data) return;
          setRowCategory((data as { payment_category?: string | null }).payment_category ?? null);
          setPaymentCreatedAt(data.created_at);
          setAlreadyAppliedDiscount(data.early_payment_discount_applied ?? null);
          const unpaid = await hasEarlierUnpaidPayment(supabase, {
            schoolId, childId: data.child_id, parentId: data.parent_id,
            excludePaymentId: paymentId, beforeCreatedAt: data.created_at,
          });
          setHasEarlierUnpaid(unpaid);
        });
    } else {
      // mode='create': el pago nace ahora mismo — dia 0 de la ventana.
      const now = new Date().toISOString();
      setPaymentCreatedAt(now);
      setAlreadyAppliedDiscount(null);
      if (childId) {
        hasEarlierUnpaidPayment(supabase, { schoolId, childId, beforeCreatedAt: now }).then(setHasEarlierUnpaid);
      }
    }
  }, [open, mode, paymentId, schoolId, childId]);

  // ── Periodo (mes/año) que cubre este pago ────────────────────────────────
  // Calculado por la RPC `next_unpaid_period`. Se usa para marcar el pago
  // con period_year/period_month y para preguntar al padre si quiere
  // adelantar cuando el mes sugerido ya esta cubierto.
  const { period: nextPeriod } = useNextUnpaidPeriod(
    open && conceptType === 'mensualidad' && !isExistingOneTime ? childId ?? null : null,
  );
  const [advancedPeriod, setAdvancedPeriod] = useState<{ year: number; month: number; label: string } | null>(null);
  const [confirmAdvanceOpen, setConfirmAdvanceOpen] = useState(false);

  // Periodo efectivo que se va a cobrar (posiblemente adelantado).
  // Un cobro único no es de ningún mes por pagar (aunque el hook haya alcanzado
  // a responder antes de leer la categoría de la fila).
  const effectivePeriod = isExistingOneTime ? null : advancedPeriod ?? (nextPeriod
    ? { year: nextPeriod.year, month: nextPeriod.month, label: nextPeriod.label }
    : null);

  // Llaves que la escuela dejó visibles. Es la misma lista contra la que el BFF
  // valida el destino del comprobante, así que lo que no aparezca acá tampoco se
  // acepta como pago válido.
  //
  // Categoría del cobro que se paga: una llave restringida (`only_for`, p.ej. el
  // Nequi de inscripciones de Dynasty) solo se muestra al pagar ese concepto.
  // En 'create' la decide el selector; en 'update' sale del concepto del cobro.
  const accountsCategory: PaymentChargeCategory | null = mode === 'create'
    ? motivoDelConcepto(conceptType)
    : existingCharge.accountsCategory;
  const payableAccounts = useMemo(
    () => resolvePaymentAccounts(bankDetails, { category: accountsCategory }),
    [bankDetails, accountsCategory],
  );
  // Link de pago genérico de la escuela (Wompi de Dynasty): botón dentro de la
  // transferencia, porque igual termina en subir el comprobante.
  const paymentLink = useMemo(
    () => resolvePaymentLink(bankDetails, { category: accountsCategory }),
    [bankDetails, accountsCategory],
  );

  useEffect(() => {
    if (!open || !schoolId) return;
    const loadBankDetails = async () => {
      const { data } = await supabase.from('school_settings')
        .select('bank_name, bank_account_type, bank_account_number, nequi_number, daviplata_number, breb_number, breb_key, transfer_key, bank_titular_name, bank_titular_id, payment_qr_url, wompi_enabled, online_fee_pct, allow_installments, min_installment_amount, early_payment_discount_enabled, early_payment_discount_days, early_payment_discount_percentage')
        .eq('school_id', schoolId).single();

      // payment_accounts (migración 20260809095613) va en un select APARTE: si el
      // ambiente todavía no la aplicó, PostgREST responde 400 y tumba la query
      // entera — el acudiente se quedaría sin ningún dato de transferencia. Así el
      // despliegue del frontend no depende de que la migración ya esté corrida.
      const { data: accounts } = await supabase.from('school_settings')
        .select('payment_accounts')
        .eq('school_id', schoolId).single();

      setBankDetails(data ? { ...data, payment_accounts: accounts?.payment_accounts ?? null } : data);
      setWompiEnabled(!!(data as any)?.wompi_enabled);
      setOnlineFeePct(Number((data as any)?.online_fee_pct ?? 3));
      setAllowInstallments(!!(data as any)?.allow_installments);
      setMinInstallmentAmount(Number((data as any)?.min_installment_amount) || 0);
      setDiscountConfig({
        enabled: !!(data as any)?.early_payment_discount_enabled,
        days: Number((data as any)?.early_payment_discount_days) || 5,
        percentage: Number((data as any)?.early_payment_discount_percentage) || 0,
      });
      setSettingsLoaded(true);
    };
    loadBankDetails();
  }, [open, schoolId]);

  // Método preseleccionado: un clic menos para el padre. Wompi si la escuela lo
  // tiene activo (es el camino inmediato); si no, transferencia, que es la única
  // opción que queda. Solo se aplica una vez por apertura y nunca pisa una
  // elección ya hecha.
  useEffect(() => {
    if (!open || !settingsLoaded || selectedMethod) return;
    // Transferencia pedida: siempre que sea un camino aceptado (o el único).
    const transferAceptada = permiteTransfer || !(wompiEnabled && permiteOnline);
    if (initialMethod === 'transfer' && transferAceptada) {
      setSelectedMethod('transfer');
      return;
    }
    setSelectedMethod(wompiEnabled && permiteOnline ? 'online' : 'transfer');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- solo al cargar settings
  }, [open, settingsLoaded, wompiEnabled, permiteOnline, initialMethod]);

  // ── Wompi checkout hook ──────────────────────────────────────────────────
  const finalAmount = conceptType === 'articulos'
    ? merchTotal
    : serviceType
    ? tournTotal
    : mode === 'create' && !['mensualidad', 'inscripcion_fija'].includes(conceptType) ? (parseFloat(customAmount) || 0) : amount;
  const finalConcept = conceptType === 'articulos'
    ? `Artículos Deportivos: ${merchConceptText || 'sin seleccionar'}`
    : serviceType
    ? conceptoDeServicios(serviceType, serviceLines)
    : mode === 'create' && conceptType !== 'mensualidad'
    ? (conceptType.startsWith('inscripcion') ? 'Inscripción Anual' : customConcept || 'Pago / Abono')
    : (effectivePeriod ? `Mensualidad ${effectivePeriod.label}` : concept);

  // Solo importa para las filas que este modal INSERTA (mode='create'): una fila
  // en mode='update' ya nació categorizada donde se creó (open_month, etc.), no
  // se retoca acá. Ver docs/specs/articulos-escolares-catalogo.md §7.
  //
  // Categoría y exención, del catálogo de motivos: todo lo que no es la
  // mensualidad va con period_uniqueness_exempt. Bug real encontrado en prueba
  // E2E (2026-09-08): artículos/torneo generan su propia fila con el
  // period_year/period_month del mes en curso, y uniq_payment_active_period_per_child
  // es UNA fila activa por (child_id, period) sin distinguir categoría — choca
  // con la mensualidad del mismo mes. Mismo fix que 20260903103757. Para la
  // inscripción y el abono el servidor ya lo forzaba (S4, 20261010145241).
  const { payment_category: paymentCategory, period_uniqueness_exempt: periodUniquenessExempt } = camposDeCategoria(conceptType);

  // Descuento por pronto pago es exclusivo de mensualidad (spec §0) — nunca
  // artículos, torneos ni un cobro único ya creado (inscripción, seguro…).
  // El servidor (S1/H5) acota el valor con la misma regla: solo mensualidad.
  const discountResult = paymentCreatedAt && earlyDiscountAppliesToCategory(paymentCategory) && !isExistingOneTime
    ? calcEarlyPaymentDiscount(finalAmount, {
      createdAt: paymentCreatedAt,
      config: discountConfig,
      hasEarlierUnpaid,
      alreadyAppliedAmount: alreadyAppliedDiscount,
    })
    : { eligible: false, discountAmount: 0, finalAmount, validUntil: null };

  const chargeAmount = discountResult.eligible ? discountResult.finalAmount : finalAmount;

  // Nunca un cobro de $0 (2026-10-13, Dynasty): «Inscripción (monto fijo)» sin
  // tarifa o un monto variable vacío terminaban en un INSERT con amount = 0 y
  // la base lo rechazaba (payments_amount_positive) con el error crudo en
  // pantalla. Artículos y torneo tienen su propio candado (total del carrito).
  const montoInvalido = !esConceptoDeCarrito(conceptType) && !(chargeAmount > 0);

  // Estimación local, solo para previsualizar antes de pedirle la sesión al servidor.
  const estimatedFee = Math.round(chargeAmount * (onlineFeePct / 100));
  const estimatedGross = chargeAmount + estimatedFee;

  // Lo que se MUESTRA: el servidor si ya respondió, la estimación mientras tanto.
  // `create-session` es la única autoridad sobre el monto — recalcula el fee con la
  // tarifa vigente y es lo que termina en la firma de integridad y en el Widget.
  const displayedBase = serverQuote?.baseAmount ?? chargeAmount;
  const sportmapsFee = serverQuote?.sportmapsFee ?? estimatedFee;
  const grossAmount = serverQuote?.grossAmount ?? estimatedGross;
  const displayedFeePct = serverQuote?.feePct ?? onlineFeePct;

  const { startSchoolPayment, loading: wompiLoading } = useWompiCheckout({
    onSuccess: () => {
      toast({ title: '¡Pago iniciado!', description: 'Estamos verificando tu pago con Wompi.' });
      onSuccess?.();
      onOpenChange(false);
    },
    onError: (err) => {
      toast({ title: 'Error en el pago', description: err.message, variant: 'destructive' });
    },
  });

  const openCheckout = async () => {
    if (montoInvalido) {
      toast({ title: 'Falta el valor', description: 'Este cobro no tiene un valor para pagar. Pídele a la escuela que lo configure.', variant: 'destructive' });
      return;
    }
    // `createdPaymentId` recuerda el cobro que creamos en un intento anterior de ESTA
    // sesión del modal. Sin él, un segundo clic (p.ej. tras confirmar un monto corregido)
    // volvería a insertar en `payments`: con mensualidad lo frena el índice único de
    // período, pero un abono u otro concepto sí quedaría duplicado.
    let effectivePaymentId = paymentId || createdPaymentId || undefined;

    // En modo "create" todavia NO existe una fila en `payments` (a diferencia de
    // MercadoPago, que la inserta en handleMpSuccess). startSchoolPayment necesita
    // un paymentId para pedirle la sesion al BFF, asi que primero creamos un cobro
    // 'pending' con provider wompi. El estado real llega despues por el webhook.
    if (!effectivePaymentId) {
      try {
        const periodYear  = conceptType === 'mensualidad' && effectivePeriod ? effectivePeriod.year  : null;
        const periodMonth = conceptType === 'mensualidad' && effectivePeriod ? effectivePeriod.month : null;
        const reference = `SCH-WOMPI-${Date.now().toString(36).toUpperCase()}`;
        const { data: inserted, error: insertError } = await supabase.from('payments').insert({
          parent_id: user?.id,
          child_id: childId || null,
          team_id: (teamId && teamId !== '') ? teamId : null,
          school_id: (schoolId && schoolId !== '') ? schoolId : null,
          branch_id: branchId || null,
          amount: finalAmount,
          concept: finalConcept,
          status: 'pending',
          // 'online' NO es un pay_method válido (pse|card|transfer|cash|other) → rompía
          // payments_payment_method_check. La pasarela resuelve el instrumento real por webhook.
          payment_method: 'other',
          payment_provider: 'wompi',
          provider_reference: reference,
          payment_type: 'one_time',
          due_date: todayColombia(),
          period_year:  periodYear,
          period_month: periodMonth,
          payment_category: paymentCategory,
          period_uniqueness_exempt: periodUniquenessExempt,
        } as any).select('id').single();
        if (insertError) {
          // 23505 en uniq_payment_active_period_per_child: ya existe un cobro activo
          // para este child+período. En vez de duplicar, reutilizamos el existente
          // (el pago online se aplica sobre ese cobro).
          if ((insertError as any).code === '23505' && childId) {
            let q = supabase.from('payments').select('id')
              .eq('school_id', schoolId)
              .eq('child_id', childId)
              .in('status', ['pending', 'awaiting_approval', 'overdue', 'partial'])
              .order('created_at', { ascending: false })
              .limit(1);
            if (periodYear != null && periodMonth != null) {
              q = q.eq('period_year', periodYear).eq('period_month', periodMonth);
            }
            const { data: existing } = await q;
            effectivePaymentId = existing?.[0]?.id;
            if (!effectivePaymentId) throw insertError;
          } else {
            throw insertError;
          }
        } else {
          effectivePaymentId = inserted?.id;
        }
      } catch (err: any) {
        toast({ title: 'Error iniciando el pago', description: mensajeErrorDeMonto(err) ?? (err?.message || 'No se pudo crear el cobro.'), variant: 'destructive' });
        return;
      }
    }

    if (!effectivePaymentId) return;
    setCreatedPaymentId(effectivePaymentId);

    // Monto que el padre tiene en pantalla en ESTE intento.
    const acceptedGross = Math.round(grossAmount);

    return startSchoolPayment({
      paymentId: effectivePaymentId,
      schoolId,
      studentName: childName,
      confirmQuote: (quote) => {
        // El servidor calculó otro total (tarifa cambiada, descuento, link recreado).
        // No abrimos el Widget: sus montos pasan a ser los que se muestran y el padre
        // confirma de nuevo sobre el valor real. Antes esto se cobraba en silencio.
        if (Math.round(quote.grossAmount) !== acceptedGross) {
          setServerQuote(quote);
          toast({
            title: 'El monto se actualizó',
            description: `El total a pagar es ${formatCurrency(quote.grossAmount)}. Revisa el desglose y confirma de nuevo.`,
          });
          return false;
        }

        // Cerramos NUESTRO modal antes de abrir el Widget de Wompi. El Dialog de
        // Radix aplica aria-hidden + pointer-events:none + scroll-lock al resto de
        // la página; el Widget de Wompi se monta como overlay aparte y, con el modal
        // abierto, queda recortado y peleando el foco ("Blocked aria-hidden…").
        onOpenChange(false);
        return true;
      },
    });
  };

  useEffect(() => {
    if (open && user?.id) {
      const checkProfile = async () => {
        setCheckingDian(true);
        const { data } = await supabase.from('profiles')
          .select('full_name, document_type, document_number, billing_address, billing_city_dane')
          .eq('id', user.id).single();
        setHasCompleteDianData(!!(data?.document_type && data?.document_number && data?.billing_address && data?.billing_city_dane));
        setCheckingDian(false);
      };
      checkProfile();
    }
  }, [open, user?.id]);

  // Guard legacy: bloquea si ya hay un pago `awaiting_approval`.
  // Para MENSUALIDADES con periodo conocido, este guard se delega al
  // flujo nuevo (next_unpaid_period + AlertDialog "¿adelantar siguiente mes?").
  // Asi el padre puede pagar Junio aunque Mayo este pendiente de validacion.
  // Para inscripcion / abono / otros conceptos, mantenemos el bloqueo total
  // porque no hay periodo y no podemos distinguir duplicados.
  //
  // Artículos y servicios (torneo, clínica, vacacional…) quedan FUERA de este
  // bloqueo (2026-09-08): son compras de catálogo independientes entre sí — un comprobante de un uniforme en espera
  // de validación no puede impedir comprarle a la familia una segunda prenda
  // o inscribirla a un torneo. No compiten por "un solo cupo" como sí lo hacen
  // inscripción/abono (que además ya tienen su propio candado sin periodo,
  // ver `reuseId` más abajo). Bug real encontrado en prueba E2E.
  useEffect(() => {
    if (!open || !studentId) return;
    if (conceptType === 'mensualidad' || esConceptoDeCarrito(conceptType)) {
      setPendingPaymentDate(null);
      setCheckingPending(false);
      return;
    }
    const checkPendingPayment = async () => {
      setCheckingPending(true);
      setPendingPaymentDate(null);
      try {
        const effectiveChildId = childId || null;
        const idColumn = effectiveChildId ? 'child_id' : 'user_id';
        const idValue = effectiveChildId || studentId;

        let query = supabase.from('payments').select('id, payment_date, created_at')
          .eq(idColumn, idValue)
          .eq('status', 'awaiting_approval')
          .limit(1);

        if (mode === 'update' && paymentId) {
          query = query.neq('id', paymentId);
        }

        const { data, error } = await query;
        if (error) { console.error('[PaymentCheckoutModal]', error); return; }
        if (data && data.length > 0) {
          const rawDate = data[0].payment_date || data[0].created_at;
          setPendingPaymentDate(rawDate ? new Date(rawDate).toLocaleDateString('es-CO', { day: '2-digit', month: 'long', year: 'numeric' }) : null);
        }
      } finally {
        setCheckingPending(false);
      }
    };
    checkPendingPayment();
  }, [open, studentId, paymentId, mode, conceptType, childId]);

  useEffect(() => {
    if (!open) {
      setPaymentStatus('idle');
      setSelectedMethod(null);
      setProofUrl(null);
      setOcrResult(null);
      setPendingPaymentDate(null);
      setSettingsLoaded(false);
      setAdvancedPeriod(null);
      setConfirmAdvanceOpen(false);
      setMpReference('');
      setServerQuote(null);
      setCreatedPaymentId(null);
      setRowCategory(null);
      setMerchLoaded(false);
      setTournLoaded(false);
    }
  }, [open]);

  // 2026-08-31: MercadoPago oculto — VITE_MP_PUBLIC_KEY_DEFAULT resuelve a la
  // cuenta comercial de ENV, que resultó ser la cuenta PERSONAL de MercadoPago
  // de un padre real de la plataforma, no una cuenta de SportMaps ni de la
  // escuela. El backend ya lo bloquea fail-closed (payment-provider.resolver.ts:
  // resolveProvider/loadProviderConfig devuelven null para mercadopago+schoolId
  // en 'aggregator'), esto además evita mostrar un botón que fallaría. Wompi no
  // se toca: sus llaves de ENV sí son de la escuela real en 'aggregator'.
  // Reactivar cuando haya una cuenta comercial real detrás de MP_ACCESS_TOKEN_DEFAULT.
  // eslint-disable-next-line no-constant-binary-expression -- kill switch intencional (SEG-23), no un error
  const mpEnabled = false && !!import.meta.env.VITE_MP_PUBLIC_KEY_DEFAULT;

  // Wompi disponible Y aceptado por quien cobra; transferencia si el cobro la
  // acepta o si no quedaría ningún otro camino (el modal no puede quedar vacío).
  const ofreceOnline = wompiEnabled && permiteOnline;
  const ofreceTransfer = permiteTransfer || !ofreceOnline;

  const paymentMethods = [
    // ── Pago online Wompi (solo si la escuela lo tiene habilitado) ────────
    ...(ofreceOnline ? [{
      id: 'online' as const,
      name: 'Pagar online (Wompi)',
      description: `Tarjeta, PSE o Nequi — inmediato y seguro`,
      icon: Globe,
      popular: true,
      enabled: true,
      badge: `+${formatCurrency(sportmapsFee)} recargo`,
    }] : []),
    // ── MercadoPago (cuando la escuela / global tiene MP configurado) ─────
    ...(mpEnabled ? [{
      id: 'mercadopago' as const,
      name: 'MercadoPago',
      description: 'Tarjeta, PSE, Efecty o wallet MP',
      icon: CreditCard,
      popular: !wompiEnabled,
      enabled: true,
      badge: `+${formatCurrency(sportmapsFee)} recargo`,
    }] : []),
    // ── Pago manual (siempre disponible) ──────────────────────────────────
    ...(ofreceTransfer ? [{ id: 'transfer' as const, name: 'Transferencia / Nequi / Daviplata', description: 'Nequi, Daviplata o transferencia bancaria', icon: Smartphone, popular: !ofreceOnline && !mpEnabled, enabled: true }] : []),
  ];

  // Generar reference MP una sola vez cuando MP esta habilitado para esta
  // sesion del modal. NO regenera al cambiar de metodo (sino el Brick perderia
  // datos cada vez que el usuario regresa a MP). Se limpia al cerrar el modal.
  useEffect(() => {
    if (mpEnabled && !mpReference) {
      const ref = `SCH-MP-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
      setMpReference(ref);
    }
  }, [mpEnabled, mpReference]);

  // Handler de éxito del Brick MP — actualiza/crea el payment row
  const handleMpSuccess = async (result: MpCreatePaymentResult) => {
    setProcessing(true);
    setPaymentStatus('processing');
    try {
      const periodYear = conceptType === 'mensualidad' && effectivePeriod ? effectivePeriod.year : null;
      const periodMonth = conceptType === 'mensualidad' && effectivePeriod ? effectivePeriod.month : null;
      const reference = mpReference || `SCH-MP-${Date.now().toString(36).toUpperCase()}`;
      // Mapeo de status MP → status interno SportMaps:
      //   approved → paid (caso ideal)
      //   pending  → pending (MP esta revisando antifraude; el webhook actualizara
      //              cuando MP confirme. NO va a 'awaiting_approval' porque eso es
      //              para comprobantes manuales que la escuela debe validar)
      //   rejected → declined
      // El navegador nunca marca 'paid' (lo rechaza trg_zz_guard_payments_client,
      // spec blindaje-dinero §1.2): el cobro queda 'pending' y el webhook de
      // MercadoPago, que verifica el monto con la pasarela, lo pasa a pagado.
      // Un pago rechazado no deja fila.
      if (result.internalStatus === 'rejected') {
        throw new Error(`Pago rechazado por MercadoPago: ${result.statusDetail}`);
      }
      const internalStatus = 'pending' as const;

      if (mode === 'update' && paymentId) {
        // NUNCA se reescribe period_year/period_month de un cobro que YA
        // existía (paymentId venía de afuera, ej. la fila que el padre
        // clickeó en /my-payments): `effectivePeriod` viene de
        // next_unpaid_period(), calculado independiente de CUÁL cobro se
        // está pagando, y podía no coincidir con el período real de esa
        // fila — el mismo bug que ya se corrigió en
        // ParentCheckoutPage.recordPaymentWithTraceability, reintroducido
        // acá porque este componente no tenía el mismo resguardo.
        const { error: updateError } = await supabase.from('payments').update({
          status: internalStatus,
          payment_method: 'card',
          payment_provider: 'mercadopago',
          provider_reference: reference,
          provider_transaction_id: String(result.paymentId),
          payment_date: todayColombia(),
          receipt_number: reference,
          early_payment_discount_applied: discountResult.eligible ? discountResult.discountAmount : null,
          updated_at: new Date().toISOString(),
        } as any).eq('id', paymentId);
        if (updateError) throw updateError;
      } else {
        const payloadChildId: string | null = childId || null;
        const payloadBranchId: string | null = branchId || null;
        const { error: insertError } = await supabase.from('payments').insert({
          parent_id: user?.id,
          child_id: payloadChildId,
          team_id: (teamId && teamId !== '') ? teamId : null,
          school_id: (schoolId && schoolId !== '') ? schoolId : null,
          branch_id: payloadBranchId,
          amount: finalAmount,
          concept: finalConcept,
          status: internalStatus,
          payment_method: 'card',
          payment_provider: 'mercadopago',
          provider_reference: reference,
          provider_transaction_id: String(result.paymentId),
          payment_type: 'one_time',
          payment_date: todayColombia(),
          due_date: todayColombia(),
          receipt_number: reference,
          period_year: periodYear,
          period_month: periodMonth,
          early_payment_discount_applied: discountResult.eligible ? discountResult.discountAmount : null,
          payment_category: paymentCategory,
          period_uniqueness_exempt: periodUniquenessExempt,
        } as any);
        if (insertError) throw insertError;
      }

      setPaymentStatus('awaiting_approval');
      toast({
        title: result.internalStatus === 'paid' ? '¡Pago recibido!' : 'Pago en proceso',
        description: result.internalStatus === 'paid'
          ? `MercadoPago aprobó ${formatCurrency(chargeAmount)}. En unos segundos queda confirmado en tu cuenta.`
          : `Estado: ${result.statusDetail}. Te notificaremos cuando se confirme.`,
      });
      setTimeout(() => { onSuccess?.(); onOpenChange(false); }, 2500);
    } catch (error: any) {
      setPaymentStatus('error');
      toast({ title: 'Error registrando el pago', description: mensajeErrorDeMonto(error) ?? error?.message ?? 'Error desconocido', variant: 'destructive' });
      setTimeout(() => setPaymentStatus('idle'), 2000);
    } finally {
      setProcessing(false);
    }
  };

  const processPayment = async () => {
    if (processing) return;
    setProcessing(true);
    setPaymentStatus('processing');
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Usuario no autenticado');

      // Build the correct child/user IDs for the payment
      const payloadChildId: string | null = childId || null;
      const payloadBranchId: string | null = branchId || null;

      // Duplicate check.
      //  - Mensualidad: bloquea solo si hay otro pago activo del MISMO mes.
      //    El unique index `uniq_payment_active_period_per_child` (migracion
      //    20260503000004) ya garantiza esto a nivel BD; aqui damos el error
      //    amigable antes del INSERT.
      //  - Inscripcion / abono / otros: bloquea cualquier awaiting_approval
      //    para ese hijo, como antes.
      const idColumn = payloadChildId ? 'child_id' : 'user_id';
      const idValue = payloadChildId || user.id;

      // Si ya existe un cobro IMPAGO (pending/overdue) del mismo periodo, se
      // REUTILIZA (se le adjunta el comprobante) en vez de insertar otro — un
      // INSERT nuevo choca con el unique index uniq_payment_active_period_per_child
      // (error 23505 "duplicate key ..."). Los estados en validacion/pagado sí bloquean.
      let reuseId: string | null = null;

      let duplicateQuery = supabase.from('payments').select('id, period_year, period_month, status')
        .eq(idColumn, idValue)
        .in('status', ['pending', 'overdue', 'awaiting_approval', 'paid', 'approved', 'partial']).limit(50);
      if (mode === 'update' && paymentId) {
        duplicateQuery = duplicateQuery.neq('id', paymentId);
      }
      const { data: pendingPayments, error: pendingError } = await duplicateQuery;
      if (pendingError) throw pendingError;

      const REUSABLE = ['pending', 'overdue'];
      const BLOCKING = ['awaiting_approval', 'paid', 'approved', 'partial'];

      if (conceptType === 'mensualidad' && effectivePeriod && !isExistingOneTime) {
        const samePeriod = (pendingPayments || []).find((p: any) =>
          p.period_year === effectivePeriod.year && p.period_month === effectivePeriod.month,
        );
        if (samePeriod) {
          if (REUSABLE.includes(samePeriod.status)) {
            reuseId = samePeriod.id;              // adjuntar comprobante a ESTE
          } else {
            throw new Error(`Ya existe un pago activo para ${effectivePeriod.label}.`);
          }
        }
      } else if (conceptType !== 'mensualidad' && !esConceptoDeCarrito(conceptType)) {
        // No-mensualidad (inscripcion / abono): reutilizar cualquier impago sin
        // periodo; si hay uno en validacion/pagado, bloquear (legacy).
        // Artículos y torneos quedan FUERA: cada compra es su propia fila
        // (period_uniqueness_exempt). Antes un cobro viejo sin periodo ya pagado
        // bloqueaba la compra con un falso "pendiente de aprobación", y uno impago
        // se quedaba con el comprobante del artículo (Dreamers, 2026-10-13).
        const reusable = (pendingPayments || []).find((p: any) =>
          !p.period_year && !p.period_month && REUSABLE.includes(p.status));
        const blocking = (pendingPayments || []).find((p: any) =>
          !p.period_year && !p.period_month && BLOCKING.includes(p.status));
        if (reusable) reuseId = reusable.id;
        else if (blocking) {
          throw new Error(blocking.status === 'awaiting_approval'
            ? 'Ya existe un pago pendiente de aprobación para este deportista.'
            : 'Este deportista ya tiene ese pago registrado.');
        }
      }

      if (mode === 'update' && paymentId && paymentId !== '') {
        const { data: existingPayment, error: fetchError } = await supabase.from('payments').select('school_id, status').eq('id', paymentId).single();
        if (fetchError || !existingPayment) throw new Error('No se encontró el pago pendiente.');
        if (existingPayment.status === 'paid') throw new Error('Este pago ya fue procesado.');
      }

      // Periodo a registrar cuando es mensualidad (NULL en otros conceptos
      // como inscripcion / abono libre).
      const periodYear = conceptType === 'mensualidad' && effectivePeriod ? effectivePeriod.year : null;
      const periodMonth = conceptType === 'mensualidad' && effectivePeriod ? effectivePeriod.month : null;

      // Objetivo de UPDATE compartido por TODOS los métodos: el pago de
      // mode='update' o el impago del mismo periodo a reutilizar (reuseId).
      // Si es null → se hace INSERT. Evita el 23505 del unique index de periodo.
      const targetId = (mode === 'update' && paymentId) ? paymentId : reuseId;
      // Solo el caso `reuseId` necesita ESTAMPAR el período (fila encontrada
      // sin período propio todavía, o el `samePeriod` ya coincide de todos
      // modos). El caso `paymentId` explícito (mode='update') es una fila que
      // YA tiene su período real — no se toca, mismo motivo que arriba.
      const isExplicitPaymentUpdate = mode === 'update' && !!paymentId;

      if (selectedMethod === 'transfer') {
        if (!proofUrl) throw new Error('Debes subir un comprobante de pago');
        // Campos OCR + veredicto (modo sombra) del comprobante, comunes a insert/update.
        const receiptOcrFields = {
          ocr_amount: ocrResult?.extractedAmount ?? null,
          ocr_currency: ocrResult?.extractedCurrency ?? null,
          ocr_date: ocrResult?.extractedDate ?? null,
          ocr_bank: ocrResult?.extractedBank ?? null,
          ocr_reference: ocrResult?.extractedReference ?? null,
          ocr_provider: ocrResult?.provider ?? null,
          ocr_destination: ocrResult?.extractedDestination ?? null,
          ocr_destination_name: ocrResult?.extractedDestinationName ?? null,
          ocr_origin_name: ocrResult?.extractedOriginName ?? null,
          ocr_time: ocrResult?.extractedTime ?? null,
          ocr_raw_response: ocrResult?.rawResponse
            ? safeParseJson(ocrResult.rawResponse) ?? ocrResult.rawResponse
            : null,
          // Veredicto de reglas: se guarda pero NO cambia el status (sombra).
          receipt_verdict: ocrResult?.verdict ?? null,
          receipt_verdict_reasons: ocrResult?.verdictReasons ?? null,
          receipt_reference_norm: ocrResult?.referenceNorm ?? null,
          receipt_image_sha256: ocrResult?.imageSha256 ?? null,
          receipt_image_sha256_source: ocrResult?.imageSha256Source ?? null,
          receipt_verdict_at: ocrResult?.verdict ? new Date().toISOString() : null,
        };
        let glosaPaymentId: string | null = targetId;
        if (targetId) {
          const { error: updateError } = await supabase.from('payments').update({
            status: 'awaiting_approval',
            payment_method: 'transfer',
            payment_date: todayColombia(),
            receipt_url: proofUrl,
            ...(isExplicitPaymentUpdate ? {} : { period_year: periodYear, period_month: periodMonth }),
            early_payment_discount_applied: discountResult.eligible ? discountResult.discountAmount : null,
            ...receiptOcrFields,
            updated_at: new Date().toISOString()
          } as any).eq('id', targetId);
          if (updateError) throw updateError;
        } else {
          const ins = await supabase.from('payments').insert({
            parent_id: user?.id,
            child_id: payloadChildId,
            team_id: (teamId && teamId !== '') ? teamId : null,
            school_id: (schoolId && schoolId !== '') ? schoolId : null,
            branch_id: payloadBranchId,
            amount: finalAmount,
            concept: finalConcept,
            status: 'awaiting_approval',
            payment_method: 'transfer',
            payment_type: 'one_time',
            payment_date: todayColombia(),
            due_date: todayColombia(),
            receipt_url: proofUrl,
            period_year: periodYear,
            period_month: periodMonth,
            early_payment_discount_applied: discountResult.eligible ? discountResult.discountAmount : null,
            ...receiptOcrFields,
            reference: `TRF-${Date.now().toString(36).toUpperCase()}`,
            payment_category: paymentCategory,
            period_uniqueness_exempt: periodUniquenessExempt,
          } as any).select('id').single();
          if (ins.error) throw ins.error;
          glosaPaymentId = ins.data?.id ?? null;
        }
        // Evaluación post-insert (Fase 5). Fire-and-forget: el BFF auto-aprueba (verde) /
        // abre glosa (amarillo) / deja manual, server-authoritative.
        if (glosaPaymentId && (ocrResult?.verdict === 'verde' || ocrResult?.verdict === 'amarillo')) {
          autoEvaluateGlosa(glosaPaymentId).catch(() => { /* dormant/no-op tolerado */ });
        }
        // El comprobante por validar ya NO se avisa desde acá: lo avisa el job
        // receipt-review-alerts del BFF al dueño Y a los admins, para todos los
        // caminos de entrada (app, bot de WhatsApp, importador), agrupado y con
        // recordatorio si pasa 2 h sin revisar. Avisarlo también acá lo duplicaba.

        setPaymentStatus('awaiting_approval');
        toast({
          title: "Pago registrado",
          description: existingChargeLabel
            ? `Comprobante de ${existingChargeLabel} enviado. La escuela lo validará pronto.`
            : effectivePeriod
            ? `Comprobante de ${effectivePeriod.label} enviado. La escuela lo validará pronto.`
            : "Tu cupo ha sido reservado. Validaremos tu comprobante pronto.",
        });
        setTimeout(() => { onSuccess?.(); onOpenChange(false); }, 3000);
        return;
      }

      // Ningún otro método registra el pago desde el navegador: en línea lo
      // confirma el webhook de la pasarela, en efectivo lo registra la escuela.
      // (Antes había aquí un camino que escribía status 'paid' directo; era
      // inalcanzable y la base ya no lo acepta — spec blindaje-dinero §1.2.)
      throw new Error('Este método de pago no está disponible.');
    } catch (error: unknown) {
      const err = error as { message?: string; code?: string };
      setPaymentStatus('error');
      // 23505 = comprobante ya usado (unique index de referencia o de hash de imagen).
      const dupMsg = err.message?.toLowerCase() ?? '';
      const isDuplicate = err.code === '23505'
        && (dupMsg.includes('ocr_reference') || dupMsg.includes('receipt_hash') || dupMsg.includes('receipt_image_sha256'));
      toast({
        title: isDuplicate ? "Comprobante ya usado" : "Error en el pago",
        description: isDuplicate
          ? "Este comprobante ya está vinculado a otro pago en esta escuela. Si crees que es un error, contacta a la administración."
          : (mensajeErrorDeMonto(err) ?? (err.message || "No se pudo procesar tu pago.")),
        variant: "destructive",
      });
      setTimeout(() => setPaymentStatus('idle'), 2000);
    } finally {
      setProcessing(false);
    }
  };

  const handleClose = () => { if (!processing) onOpenChange(false); };

  // ── Handler que decide si abre el AlertDialog "¿adelantar siguiente mes?"
  // antes de procesar el pago. Solo aplica al concepto 'mensualidad'.
  const handlePayClick = () => {
    if (processing) return;
    if (!selectedMethod) return;
    if (conceptType === 'articulos' && Object.keys(merchSelected).length === 0) return;
    if (serviceType && serviceLines.length === 0) return;

    // No-mensualidad o sin info de periodo → flujo directo
    if (conceptType !== 'mensualidad' || isExistingOneTime || !nextPeriod || !childId) {
      void processPayment();
      return;
    }

    // El mes sugerido todavia esta libre → cobramos ese mes
    if (!isPeriodActive(nextPeriod.current_status as PeriodStatus)) {
      void processPayment();
      return;
    }

    // El mes sugerido ya tiene un pago activo → preguntamos si adelantar
    setConfirmAdvanceOpen(true);
  };

  // Calcula el mes siguiente al sugerido y verifica que tampoco este pagado.
  // Si tambien esta pagado, salta al siguiente y asi sucesivamente (max 12
  // saltos para evitar loops). Setea advancedPeriod y dispara processPayment.
  const handleConfirmAdvance = async () => {
    if (!nextPeriod || !childId) {
      setConfirmAdvanceOpen(false);
      return;
    }
    let y = nextPeriod.year;
    let m = nextPeriod.month + 1;
    if (m > 12) { m = 1; y += 1; }

    // Saltar meses que ya esten cubiertos (si el padre adelanto varios)
    for (let i = 0; i < 12; i++) {
      try {
        const result = await fetchPeriodStatus(childId, y, m);
        if (!isPeriodActive(result.status)) break;
      } catch {
        break;
      }
      m += 1;
      if (m > 12) { m = 1; y += 1; }
    }

    setAdvancedPeriod({
      year: y,
      month: m,
      label: `${[
        'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
        'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'
      ][m - 1]} ${y}`,
    });
    setConfirmAdvanceOpen(false);
    // Defer al siguiente tick para que finalConcept use el nuevo periodo
    setTimeout(() => { void processPayment(); }, 0);
  };

  return (
    <>
      <Dialog open={open} onOpenChange={handleClose}>
        {/*
        RESPONSIVE KEY:
        - Mobile (<sm): w-[100vw] h-[100dvh] rounded-none → full screen sheet
        - sm+: max-w-md centrado con border-radius normal
        El dvh (dynamic viewport height) evita el problema del teclado virtual en iOS
      */}
        <DialogContent
          className="
        w-[100vw] h-[100dvh] max-h-[100dvh] rounded-none overflow-y-auto p-4 pt-[max(1rem,env(safe-area-inset-top))]
        sm:w-full sm:max-w-md sm:h-auto sm:max-h-[90vh] sm:rounded-lg sm:p-6
        "
          onPointerDownOutside={(e) => {
            // Si MP brick esta montado con datos posibles, prevenir cierre por
            // click fuera (el iframe MP no permite recuperar los datos).
            if (mpReference) e.preventDefault();
          }}
          onEscapeKeyDown={(e) => {
            if (mpReference) e.preventDefault();
          }}
        >
          <DialogHeader className="text-left">
            <DialogTitle className="text-xl sm:text-2xl">
              {existingChargeLabel
                ? existingChargeLabel
                : conceptType === 'mensualidad' && effectivePeriod
                ? `Mensualidad ${effectivePeriod.label}`
                : 'Realizar Pago'}
            </DialogTitle>
            <DialogDescription>
              {existingChargeLabel && childName
                ? `Pago para ${childName}`
                : conceptType === 'mensualidad' && effectivePeriod && childName
                ? `Pago para ${childName} — ${effectivePeriod.label}`
                : 'Selecciona tu método de pago preferido'}
            </DialogDescription>
          </DialogHeader>

          {/* Estado 1: Verificando */}
          {checkingPending && (
            <div className="py-12 text-center space-y-4">
              <Loader2 className="h-10 w-10 mx-auto text-muted-foreground animate-spin" />
              <p className="text-sm text-muted-foreground">Verificando pagos pendientes...</p>
            </div>
          )}

          {/* Estado 2: Bloqueado */}
          {!checkingPending && pendingPaymentDate !== null && paymentStatus === 'idle' && (
            <div className="py-8 text-center space-y-5">
              <div className="w-16 h-16 mx-auto bg-amber-100 rounded-full flex items-center justify-center">
                <AlertTriangle className="h-9 w-9 text-amber-500" />
              </div>
              <div className="space-y-2">
                <h3 className="text-lg font-semibold text-amber-600">Pago en espera de validación</h3>
                <p className="text-sm text-muted-foreground px-4">
                  Ya existe un comprobante enviado el <span className="font-medium text-foreground">{pendingPaymentDate}</span> pendiente de aprobación.
                </p>
                <p className="text-xs text-muted-foreground px-6">
                  No puedes registrar un nuevo pago hasta que ese comprobante sea aprobado o rechazado.
                </p>
              </div>
              <Button variant="outline" onClick={() => onOpenChange(false)}>Entendido</Button>
            </div>
          )}

          {/* Estado 3: Formulario */}
          {!checkingPending && pendingPaymentDate === null && paymentStatus === 'idle' && (
            <div className="space-y-5 py-2">
              {/* Resumen */}
              <div className="bg-primary/5 rounded-lg p-4 space-y-4">
                {mode === 'create' ? (
                  <>
                    <div className="space-y-2">
                      <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Tipo de Pago</Label>
                      <Select value={conceptType} onValueChange={(v: any) => setConceptType(v)}>
                        <SelectTrigger className="bg-white text-gray-900 border-gray-300 data-[placeholder]:text-gray-500">
                          <SelectValue placeholder="Concepto" />
                        </SelectTrigger>
                        <SelectContent className="bg-white text-gray-900">
                          {/* Del catálogo de motivos (checkoutConcepto.opcionesDeCheckout):
                              inscripción de monto fijo solo con tarifa; monto variable y abono
                              libre solo si la escuela recibe abonos (allow_installments) — una
                              escuela sin abonos (Dynasty) no debe dejar que la familia invente
                              un cobro ni un valor —; artículos y cada tipo de servicio solo si
                              la escuela tiene ítems. */}
                          {conceptOptions.map((o) => (
                            <SelectItem key={o.value} value={o.value} className="text-gray-900 focus:bg-gray-100 focus:text-gray-900">{o.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    {conceptType === 'otro' && (
                      <div className="space-y-2">
                        <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Descripción del Pago</Label>
                        <Input placeholder="Ej. Uniforme, Aporte especial..." value={customConcept} onChange={(e) => setCustomConcept(e.target.value)} className="bg-white" />
                      </div>
                    )}
                    {conceptType === 'articulos' && (
                      <div className="space-y-2">
                        <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Elige los artículos</Label>
                        <div className="space-y-1.5">
                          {merchCatalog.map((item) => {
                            const sel = merchSelected[item.id];
                            const sizes = item.size_options ? item.size_options.split(',').map((s) => s.trim()).filter(Boolean) : [];
                            return (
                              <div
                                key={item.id}
                                className={`rounded-lg border-2 p-2.5 transition-all ${sel ? 'border-primary bg-primary/5' : 'border-border'}`}
                              >
                                <button type="button" onClick={() => toggleMerchItem(item)} className="w-full flex items-center gap-2.5 text-left">
                                  <span className={`h-5 w-5 rounded-md border-2 flex items-center justify-center shrink-0 ${sel ? 'bg-primary border-primary' : 'border-gray-300'}`}>
                                    {sel && <CheckCircle2 className="h-4 w-4 text-white" />}
                                  </span>
                                  <span className="flex-1 min-w-0">
                                    <span className="block text-sm font-medium text-gray-900">{item.name}</span>
                                    <span className="block text-xs text-muted-foreground">{formatCurrency(item.price)}</span>
                                  </span>
                                </button>
                                {sel && (
                                  <div className="mt-2 pl-7 flex items-center gap-3 flex-wrap">
                                    {sizes.length > 0 && (
                                      <Select value={sel.size || undefined} onValueChange={(v) => setMerchSelected((prev) => ({ ...prev, [item.id]: { ...prev[item.id], size: v } }))}>
                                        <SelectTrigger className="h-8 w-24 bg-white text-xs"><SelectValue placeholder="Talla" /></SelectTrigger>
                                        <SelectContent className="bg-white text-gray-900">
                                          {sizes.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                                        </SelectContent>
                                      </Select>
                                    )}
                                    <div className="flex items-center gap-2">
                                      <button type="button" className="h-7 w-7 rounded border flex items-center justify-center text-sm" onClick={() => setMerchQty(item.id, sel.qty - 1)}>−</button>
                                      <span className="text-sm font-medium w-4 text-center">{sel.qty}</span>
                                      <button type="button" className="h-7 w-7 rounded border flex items-center justify-center text-sm" onClick={() => setMerchQty(item.id, sel.qty + 1)}>+</button>
                                    </div>
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                    {serviceType && (
                      <div className="space-y-2">
                        <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Elige los cobros</Label>
                        <div className="space-y-1.5">
                          {serviceItems.map((item) => {
                            const sel = tournSelected[item.id];
                            const opciones = parseOpciones(item.opciones);
                            const precioDe = (opcion: string | null) => precioDeServicio(item, { afiliado: true, hoy: hoyBogota, opcion });
                            const linea = serviceLines.find((l) => l.item.id === item.id);
                            const precioVisible = linea
                              ? formatCurrency(linea.precio)
                              : opciones.length > 1
                              ? `Desde ${formatCurrency(Math.min(...opciones.map((o) => precioDe(o.clave))))}`
                              : formatCurrency(precioDe(opciones[0]?.clave ?? null));
                            return (
                              <div
                                key={item.id}
                                className={`rounded-lg border-2 p-2.5 transition-all ${sel ? 'border-primary bg-primary/5' : 'border-border'}`}
                              >
                                <button type="button" aria-pressed={!!sel} onClick={() => toggleTournItem(item)} className="w-full flex items-center gap-2.5 text-left">
                                  <span className={`h-5 w-5 rounded-md border-2 flex items-center justify-center shrink-0 ${sel ? 'bg-primary border-primary' : 'border-gray-300'}`}>
                                    {sel && <CheckCircle2 className="h-4 w-4 text-white" />}
                                  </span>
                                  <span className="flex-1 min-w-0">
                                    <span className="block text-sm font-medium text-gray-900">{item.name}</span>
                                    <span className="block text-xs text-muted-foreground">{precioVisible}</span>
                                  </span>
                                </button>
                                {sel && (
                                  <div className="mt-2 pl-7 flex items-center gap-3 flex-wrap">
                                    {opciones.length > 0 && (
                                      <Select value={linea?.opcion?.clave ?? opciones[0].clave} onValueChange={(v) => setTournOpcion(item.id, v)}>
                                        <SelectTrigger aria-label={`Opción de ${item.name}`} className="h-8 w-36 bg-white text-xs"><SelectValue placeholder="Opción" /></SelectTrigger>
                                        <SelectContent className="bg-white text-gray-900">
                                          {opciones.map((o) => <SelectItem key={o.clave} value={o.clave}>{o.etiqueta} · {formatCurrency(precioDe(o.clave))}</SelectItem>)}
                                        </SelectContent>
                                      </Select>
                                    )}
                                    <div className="flex items-center gap-2">
                                      <button type="button" aria-label={`Uno menos de ${item.name}`} className="h-7 w-7 rounded border flex items-center justify-center text-sm" onClick={() => setTournQty(item.id, sel.qty - 1)}>−</button>
                                      <span className="text-sm font-medium w-4 text-center">{sel.qty}</span>
                                      <button type="button" aria-label={`Uno más de ${item.name}`} className="h-7 w-7 rounded border flex items-center justify-center text-sm" onClick={() => setTournQty(item.id, sel.qty + 1)}>+</button>
                                    </div>
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                    <div className="space-y-2">
                      <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                        {conceptType === 'articulos' ? 'Subtotal artículos' : serviceType ? `Subtotal ${definicionDeMotivo(serviceType).plural}` : 'Monto ($ COP)'}
                      </Label>
                      {conceptType === 'articulos' ? (
                        <p className="text-2xl sm:text-3xl font-bold text-primary">{formatCurrency(merchTotal)}</p>
                      ) : serviceType ? (
                        <p className="text-2xl sm:text-3xl font-bold text-primary">{formatCurrency(tournTotal)}</p>
                      ) : ['mensualidad', 'inscripcion_fija'].includes(conceptType) ? (
                        <div className="flex items-baseline gap-2">
                          {discountResult.eligible && discountResult.discountAmount > 0 ? (
                            <div className="flex items-baseline gap-1.5">
                              <span className="text-sm text-muted-foreground line-through font-normal">
                                {formatCurrency(amount)}
                              </span>
                              <span className="text-2xl sm:text-3xl font-bold text-primary">
                                {formatCurrency(chargeAmount)}
                              </span>
                            </div>
                          ) : (
                            <p className="text-2xl sm:text-3xl font-bold text-primary">{formatCurrency(amount)}</p>
                          )}
                          <p className="text-sm text-muted-foreground">/ {conceptType === 'mensualidad' ? 'mes' : 'tarifa plan'}</p>
                        </div>
                      ) : (
                        <div className="relative">
                          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground font-semibold">$</span>
                          <Input type="number" min="0" value={customAmount} onChange={(e) => setCustomAmount(e.target.value)} className="bg-white pl-7 text-lg font-bold text-primary" placeholder="Ej. 150000" />
                        </div>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="space-y-1">
                    <p className="text-xs text-muted-foreground">Concepto</p>
                    <p className="font-semibold text-base leading-tight">{concept}</p>
                    <div className="flex items-baseline gap-2">
                      {discountResult.eligible && discountResult.discountAmount > 0 ? (
                        <div className="flex items-baseline gap-1.5">
                          <span className="text-sm text-muted-foreground line-through font-normal">
                            {formatCurrency(amount)}
                          </span>
                          <span className="text-2xl sm:text-3xl font-bold text-primary">
                            {formatCurrency(chargeAmount)}
                          </span>
                        </div>
                      ) : (
                        <p className="text-2xl sm:text-3xl font-bold text-primary">{formatCurrency(amount)}</p>
                      )}
                      <p className="text-sm text-muted-foreground">cobro pendiente</p>
                    </div>
                  </div>
                )}
                {discountResult.eligible && discountResult.discountAmount > 0 && (
                  <div className="rounded-lg border border-emerald-300 bg-emerald-50 dark:bg-emerald-950/30 p-3 flex items-start gap-2">
                    <Percent className="h-4 w-4 text-emerald-600 shrink-0 mt-0.5" />
                    <div className="text-sm">
                      <p className="font-semibold text-emerald-700 dark:text-emerald-400">
                        Descuento por pronto pago: −{formatCurrency(discountResult.discountAmount)}
                      </p>
                      <p className="text-xs text-emerald-700/80 dark:text-emerald-400/80">
                        Pagas {formatCurrency(chargeAmount)} en vez de {formatCurrency(finalAmount)}
                        {discountResult.validUntil ? ` · válido hasta ${discountResult.validUntil}` : ''}
                      </p>
                    </div>
                  </div>
                )}
              </div>

              {/* Métodos */}
              <div className="space-y-3">
                <p className="font-medium text-sm">Método de pago:</p>
                {paymentMethods.map((method) => {
                  const Icon = method.icon;
                  const isSelected = selectedMethod === method.id;
                  const isDisabled = !method.enabled;
                  return (
                    <button
                      key={method.id}
                      onClick={() => !isDisabled && setSelectedMethod(method.id)}
                      disabled={isDisabled}
                      className={`w-full flex items-center gap-3 p-3 sm:p-4 border-2 rounded-lg transition-all text-left ${isDisabled ? 'border-border/50 opacity-50 cursor-not-allowed bg-muted/30'
                        : isSelected ? 'border-primary bg-primary/5' : 'border-border hover:border-primary'
                        }`}
                    >
                      <div className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${isDisabled ? 'bg-muted/50' : isSelected ? 'bg-primary text-white' : 'bg-muted'}`}>
                        <Icon className="h-5 w-5" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="font-semibold text-sm">{method.name}</p>
                          {method.popular && method.enabled && <Badge variant="secondary" className="text-xs">Recomendado</Badge>}
                          {isDisabled && <Badge variant="outline" className="text-xs text-muted-foreground">Próximamente</Badge>}
                          {(method as any).badge && <Badge variant="outline" className="text-xs text-amber-600 border-amber-300">{(method as any).badge}</Badge>}
                        </div>
                        <p className="text-xs text-muted-foreground">{method.description}</p>
                      </div>
                      {isSelected && !isDisabled && <CheckCircle2 className="h-5 w-5 text-primary shrink-0" />}
                    </button>
                  );
                })}
              </div>

              {/* Formulario DIAN si falta */}
              {selectedMethod && !checkingDian && !dianDataOk && (
                <div className="pt-4 border-t">
                  <BillingDetailsForm onComplete={() => setHasCompleteDianData(true)} />
                </div>
              )}

              {/* Datos bancarios */}
              {selectedMethod === 'transfer' && dianDataOk && (
                <div className="space-y-4 animate-in fade-in slide-in-from-top-2">
                  {paymentLink && <PaymentLinkButton url={paymentLink} />}
                  <Alert variant="default" className="bg-primary/5 border-primary/20">
                    <Info className="h-4 w-4 text-primary shrink-0" />
                    <AlertTitle className="text-primary font-bold text-sm">Información de Transferencia</AlertTitle>
                    <AlertDescription className="space-y-2 mt-2">
                      <p className="text-sm">
                        {payableAccounts.length + (bankDetails?.bank_account_number ? 1 : 0) > 1
                          ? 'Realiza tu transferencia a cualquiera de estas cuentas:'
                          : 'Realiza tu transferencia a la siguiente cuenta:'}
                      </p>
                      {bankDetails ? (
                        <div className="bg-background/80 p-3 rounded border space-y-1.5 text-xs break-all">
                          {([
                            bankDetails.bank_name && { label: 'Banco', value: `${bankDetails.bank_name}${bankDetails.bank_account_type ? ` (${bankDetails.bank_account_type})` : ''}`, copy: false },
                            bankDetails.bank_account_number && { label: 'Número', value: bankDetails.bank_account_number, copy: true },
                            // Las llaves salen de payment_accounts: la escuela puede tener
                            // varias del mismo tipo y el OCR solo acepta las que estén acá.
                            ...payableAccounts.map(a => ({ label: accountDisplayLabel(a), value: a.value, copy: true })),
                            bankDetails.bank_titular_name && { label: 'Titular', value: bankDetails.bank_titular_name, copy: false },
                            bankDetails.bank_titular_id && { label: 'NIT/CC', value: bankDetails.bank_titular_id, copy: true },
                          ].filter(Boolean) as { label: string; value: string; copy: boolean }[]).map((f, i) => (
                            <div key={i} className="flex items-center justify-between gap-2">
                              <span className="font-mono"><strong className="font-sans">{f.label}:</strong> {f.value}</span>
                              {f.copy && (
                                <button
                                  type="button"
                                  aria-label={`Copiar ${f.label}`}
                                  className="shrink-0 text-primary hover:text-primary/70 p-1"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    const text = String(f.value);
                                    if (navigator.clipboard?.writeText) {
                                      navigator.clipboard.writeText(text).then(
                                        () => toast({ title: 'Copiado', description: `${f.label} copiado.` }),
                                        () => toast({ title: 'No se pudo copiar', description: text }),
                                      );
                                    } else {
                                      toast({ title: `${f.label}`, description: `Cópialo manualmente: ${text}` });
                                    }
                                  }}
                                >
                                  <Copy className="h-3.5 w-3.5" />
                                </button>
                              )}
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-xs italic text-muted-foreground">La escuela no ha configurado sus datos bancarios aún.</p>
                      )}
                      {bankDetails?.payment_qr_url && (
                        <div className="mt-3 text-center flex flex-col items-center">
                          <p className="text-xs font-semibold mb-2 text-muted-foreground">O escanea este QR:</p>
                          <div
                            className="relative group cursor-pointer overflow-hidden rounded-lg border shadow-sm transition-all duration-300 hover:shadow-md hover:scale-[1.02]"
                            onClick={(e) => { e.stopPropagation(); setShowFullQr(true); }}
                          >
                            <img
                              src={bankDetails.payment_qr_url}
                              alt="QR de Pago"
                              className="w-28 h-28 sm:w-32 sm:h-32 object-cover"
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
                    </AlertDescription>
                  </Alert>
                  <div className="space-y-2">
                    <p className="font-medium text-sm">Sube tu comprobante:</p>
                    <FileUpload
                      bucket="payment-receipts"
                      accept="image/*,application/pdf"
                      validateReceipt={true}
                      schoolId={schoolId || undefined}
                      paymentId={mode === 'update' ? (paymentId || undefined) : undefined}
                      paymentCategory={accountsCategory}
                      onUploadComplete={(url) => setProofUrl(url)}
                      onValidationResult={(r) => setOcrResult(r)}
                      expectedAmount={chargeAmount}
                      // Bloqueo estricto solo en concept fijo (mensualidad/inscripcion fija).
                      // Para abono / inscripcion variable / otros, OCR es advisory.
                      conceptKind={
                        conceptType === 'mensualidad' || conceptType === 'inscripcion_fija'
                          ? 'fixed'
                          : 'lenient'
                      }
                      allowPartial={allowInstallments}
                      minPartialAmount={minInstallmentAmount}
                    />
                    {proofUrl && (
                      <p className="text-xs text-green-600 flex items-center gap-1">
                        <CheckCircle2 className="h-3 w-3" /> Comprobante cargado correctamente
                      </p>
                    )}
                  </div>
                </div>
              )}

              {/* Brick MercadoPago — solo se monta cuando el usuario selecciona MP.
                IMPORTANT: NO usar display:none para ocultarlo cuando otro metodo
                esta seleccionado, porque el SDK MP mide el contenedor durante
                .render() y con display:none queda con width/height=0, lo que
                causa errores 'Could not find container' y SVG vacios. */}
              {dianDataOk && mpReference && mpEnabled && selectedMethod === 'mercadopago' && (
                <div className="space-y-2 pt-2 animate-in fade-in slide-in-from-top-2">
                  <MercadoPagoBrick
                    key={mpReference}
                    publicKey={import.meta.env.VITE_MP_PUBLIC_KEY_DEFAULT}
                    sandbox={false}
                    transactionAmount={chargeAmount}
                    externalReference={mpReference}
                    payerEmail={user?.email || 'demo@sportmaps.co'}
                    payerFirstName={(user?.user_metadata?.full_name || 'Padre').split(' ')[0]}
                    payerLastName={(user?.user_metadata?.full_name || '').split(' ').slice(1).join(' ') || 'Demo'}
                    description={`${finalConcept} — ${childName ?? 'deportista'}`}
                    schoolId={schoolId}
                    onSuccess={handleMpSuccess}
                    onPending={handleMpSuccess}
                    onError={(err) => toast({ title: 'Error en MercadoPago', description: err.message, variant: 'destructive' })}
                  />
                  <Button variant="outline" className="w-full" onClick={handleClose} disabled={processing}>Cancelar</Button>
                </div>
              )}

              {/* Botones acción para los demás métodos (no online ni MP) */}
              {dianDataOk && selectedMethod !== 'online' && selectedMethod !== 'mercadopago' && (
                <div className="space-y-2 pt-2">
                  <Button className="w-full" size="lg" disabled={!selectedMethod || processing || montoInvalido || (conceptType === 'articulos' && merchTotal === 0) || (!!serviceType && tournTotal === 0)} onClick={handlePayClick}>
                    {processing ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Procesando...</> : `Pagar ${formatCurrency(chargeAmount)}`}
                  </Button>
                  <Button variant="outline" className="w-full" onClick={handleClose} disabled={processing}>Cancelar</Button>
                </div>
              )}

              {/* Botón online → abre el Widget de Wompi directo. Antes pasaba por un
                  segundo modal de confirmación que solo repetía el desglose del
                  recargo; ese desglose ahora vive aquí mismo y el padre paga con un
                  clic menos. Si el servidor cotiza otro total, confirmQuote no abre el
                  Widget: actualiza estos montos y el padre vuelve a tocar el botón. */}
              {selectedMethod === 'online' && (
                <div className="space-y-3 pt-2">
                  <div className="rounded-lg bg-muted/50 p-3 text-sm space-y-1.5">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Valor</span>
                      <span className="font-medium">{formatCurrency(displayedBase)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Recargo por pago online ({displayedFeePct}%)</span>
                      <span className="font-medium text-amber-600">+{formatCurrency(sportmapsFee)}</span>
                    </div>
                    <div className="flex justify-between border-t pt-1.5">
                      <span className="font-semibold">Total a pagar</span>
                      <span className="font-bold text-primary">{formatCurrency(grossAmount)}</span>
                    </div>
                  </div>
                  <Button
                    className="w-full bg-green-600 hover:bg-green-700"
                    size="lg"
                    disabled={wompiLoading || montoInvalido}
                    onClick={openCheckout}
                  >
                    {wompiLoading ? (
                      <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Conectando con Wompi...</>
                    ) : (
                      `Pagar online ${formatCurrency(grossAmount)}`
                    )}
                  </Button>
                  <Button variant="outline" className="w-full" onClick={handleClose} disabled={wompiLoading}>Cancelar</Button>
                </div>
              )}

              <p className="text-xs text-center text-muted-foreground">
                {selectedMethod === 'transfer'
                  ? "El comprobante será revisado por la administración antes de validarse."
                  : selectedMethod === 'online'
                    ? `Incluye ${formatCurrency(sportmapsFee)} de recargo por pago online. Tu escuela recibe la mensualidad completa de ${formatCurrency(displayedBase)}.`
                    : "🔒 Pago 100% seguro."}
              </p>
            </div>
          )}

          {/* Estado: Procesando */}
          {paymentStatus === 'processing' && (
            <div className="py-12 text-center space-y-4">
              <Loader2 className="h-16 w-16 mx-auto text-primary animate-spin" />
              <div>
                <h3 className="text-lg font-semibold">Procesando tu pago...</h3>
                <p className="text-sm text-muted-foreground">Esto puede tomar unos segundos</p>
              </div>
            </div>
          )}

          {/* Estado: Éxito */}
          {paymentStatus === 'success' && (
            <div className="py-12 text-center space-y-4">
              <div className="w-16 h-16 mx-auto bg-green-100 rounded-full flex items-center justify-center">
                <CheckCircle2 className="h-10 w-10 text-green-600" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-green-600">¡Pago exitoso!</h3>
                <p className="text-sm text-muted-foreground">Tu pago de {formatCurrency(chargeAmount)} fue procesado correctamente</p>
              </div>
            </div>
          )}

          {/* Estado: En verificación */}
          {paymentStatus === 'awaiting_approval' && (
            <div className="py-12 text-center space-y-4">
              <div className="w-16 h-16 mx-auto bg-blue-100 rounded-full flex items-center justify-center">
                <Clock className="h-10 w-10 text-blue-600" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-blue-600">Pago en Verificación</h3>
                <p className="text-sm text-muted-foreground px-4">
                  Hemos recibido tu comprobante. Será validado pronto por la escuela.
                </p>
              </div>
              <Button variant="outline" onClick={() => onOpenChange(false)}>Entendido</Button>
            </div>
          )}

          {/* Estado: Error */}
          {paymentStatus === 'error' && (
            <div className="py-12 text-center space-y-4">
              <div className="w-16 h-16 mx-auto bg-red-100 rounded-full flex items-center justify-center">
                <XCircle className="h-10 w-10 text-red-600" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-red-600">Pago rechazado</h3>
                <p className="text-sm text-muted-foreground">No se pudo procesar tu pago. Por favor, inténtalo de nuevo.</p>
              </div>
              <Button onClick={() => setPaymentStatus('idle')}>Intentar de nuevo</Button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* ── Confirmacion: ¿adelantar el siguiente mes? ──────────────────────── */}
      <AlertDialog open={confirmAdvanceOpen} onOpenChange={setConfirmAdvanceOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {nextPeriod && `${nextPeriod.label} ya tiene un pago activo`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {nextPeriod?.current_status === 'paid' || nextPeriod?.current_status === 'approved'
                ? `Ya pagaste ${nextPeriod.label} para ${childName ?? 'este deportista'}.`
                : nextPeriod?.current_status === 'awaiting_approval'
                  ? `Hay un comprobante de ${nextPeriod?.label} esperando validacion de la escuela.`
                  : `Ya hay un cobro registrado para ${nextPeriod?.label}.`}
              {' '}¿Deseas adelantar el siguiente mes?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              Cancelar
            </AlertDialogCancel>
            <AlertDialogAction onClick={() => { void handleConfirmAdvance(); }}>
              Sí, adelantar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={showFullQr} onOpenChange={setShowFullQr}>
        <DialogContent className="sm:max-w-md max-w-[90vw] rounded-xl p-6 flex flex-col items-center justify-center bg-background/95 backdrop-blur-md border border-primary/20 shadow-2xl animate-in fade-in zoom-in-95 duration-200">
          <DialogHeader className="w-full text-center mb-2">
            <DialogTitle className="text-lg font-bold text-foreground">QR de Pago</DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              Escanea este código desde la app de tu banco para realizar la transferencia a la escuela
            </DialogDescription>
          </DialogHeader>

          <div className="bg-white p-4 rounded-xl border shadow-inner flex items-center justify-center max-w-full max-h-[60vh] overflow-hidden">
            <img
              src={bankDetails?.payment_qr_url || ''}
              alt="Código QR de Pago Completo"
              className="max-w-full max-h-[50vh] object-contain rounded-lg transition-transform duration-300 hover:scale-105"
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
                  a.download = `qr-pago-${(concept || 'pago').toLowerCase().replace(/\s+/g, '-')}.png`;
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
    </>
  );
}