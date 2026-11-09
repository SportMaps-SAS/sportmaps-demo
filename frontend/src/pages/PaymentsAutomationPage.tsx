import { destinoDelComprobante } from '@/lib/destinoComprobante';
import { useState, useEffect, useRef } from 'react';
import { BranchChip } from '@/components/common/BranchChip';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import { NumberStepper } from '@/components/ui/number-stepper';
import { CheckCircle2, Clock, CreditCard, TrendingUp, Download, Eye, EyeOff, Loader2, XCircle, Save, Bell, DollarSign, Shield, AlertTriangle, Trophy, Zap, Banknote, UserPlus } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { Navigate, useSearchParams } from 'react-router-dom';
import { formatCurrency, maskSensitive } from '@/lib/utils';
import { chargeLabel, isOneOffCharge } from '@/lib/payment-accounts';
import { contarPorTipo, nombreDeQuienAsiste, textoDeTipo, tipoDeCobro } from '@/lib/tipoDeCobro';
import { ExternoBadge, TipoDeCobroBadge } from '@/components/payments/TipoDeCobroBadge';
import { FiltroTipoDeCobro, TODOS_LOS_TIPOS } from '@/components/payments/FiltroTipoDeCobro';
import { normalizeReceiptUrl } from '@/lib/normalizeReceiptUrl';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/integrations/supabase/client';
import { getUserFriendlyError } from '@/lib/error-translator';
import { useSchoolContext } from '@/hooks/useSchoolContext';
import { ReferidosPanel } from '@/components/referidos/ReferidosPanel';
import { AjustesAcuerdos, BandejaAcuerdos } from '@/components/acuerdos-de-pago';
import { useIsMobile } from '@/hooks/use-mobile';
import { useOcultarFabSoporte } from '@/lib/supportFab';
import { FileUpload } from '@/components/common/FileUpload';
import { StatFilterBar } from '@/components/common/StatFilterBar';
import { TableRefreshBar } from '@/components/common/TableRefreshBar';
import { emailClient } from '@/lib/email-client';
import { InstallmentsConfigCard } from '@/components/payment/InstallmentsConfigCard';
import { todayColombia, formatDayCO, daysDiffFromToday } from '@/lib/dateUtils';
import { SportMapsPaySettings } from '@/components/settings/SportMapsPaySettings';
import { PaymentProvidersAdmin } from '@/components/admin/PaymentProvidersAdmin';
import { CobrosYPagosModal } from '@/components/payment/CobrosYPagosModal';
import { claveAtleta, juntarPorAtleta, marcarGrupos, ordenarPagosRecibidos } from '@/lib/pagosRecibidosOrden';
import { ClasesDePruebaDialog } from '@/components/payment/ClasesDePruebaDialog';
import { OperacionesTab } from '@/components/payment/OperacionesTab';
import { isCobrosYPagosEnabled } from '@/lib/cobrosYPagosFlag';
import { canManageCharges, canReadChargeBatches, isMensualidad } from '@/lib/cobrosYPagos';
import { ApprovePaymentMethodSheet } from '@/components/payment/ApprovePaymentMethodSheet';
import { RejectReceiptDialog } from '@/components/payment/RejectReceiptDialog';
import { BulkApproveGreensDialog } from '@/components/payment/BulkApproveGreensDialog';
import { sortReviewQueue, waitingLabel, waitingSince, bulkGreenSelection, receiptGroups, keepReceiptGroupsTogether, orderReceiptGroup, joinSpanish, remainingOf } from '@/lib/receiptReview';
import { bffClient } from '@/lib/api/bffClient';
import { GlosaConciliationDialog } from '@/components/payment/GlosaConciliationDialog';
import { ReconciliationTab } from '@/components/payment/ReconciliationTab';
import { CreateGlosaDialog } from '@/components/payment/CreateGlosaDialog';
import { listBySchool as listSchoolGlosas, REASON_ADMIN_LABELS, STATUS_LABELS, OPEN_GLOSA_STATUSES, type Glosa } from '@/lib/api/glosas';
import { PaymentOriginBadge } from '@/components/payment/PaymentOriginBadge';
import { FailedAttemptChip } from '@/components/payment/FailedAttemptChip';
import { isGatewayPayment } from '@/lib/paymentOrigin';
import { PaymentAccountsEditor } from '@/components/payment/PaymentAccountsEditor';
import { SellableCatalogCard } from '@/components/settings/SellableCatalogCard';
import { MonthCloseTab } from '@/components/finances/MonthCloseTab';
import { DebitoAutomaticoPanel } from '@/components/autopay/DebitoAutomaticoPanel';
import {
  resolvePaymentAccounts,
  serializePaymentAccounts,
  accountsToLegacyColumns,
  isPaymentLink,
  isValidPaymentLinkUrl,
  type PaymentAccount,
  type LegacyAccountColumns,
} from '@/lib/payment-accounts';


interface BillingSettings {
  school_id: string;
  payment_cutoff_day: number;
  payment_grace_days: number;
  auto_generate_payments: boolean;
  reminder_enabled: boolean;
  reminder_days_before: number;
  late_fee_enabled: boolean;
  late_fee_percentage: number;
  allow_coach_messaging: boolean;
  /** El entrenador puede inscribir en equipos con cobro (genera mensualidad). */
  coach_can_enroll_paid_teams: boolean;
  /** El entrenador puede subir fotos de hojas de matrícula (las aprueba la escuela). */
  coach_can_upload_enrollment_forms?: boolean;
  /** El entrenador podrá subir fotos de planillas de asistencia (F1, aún sin construir). */
  coach_can_upload_attendance_sheets?: boolean;
  /** El entrenador puede remover deportistas de SUS equipos (cancelar anula cobros pendientes). */
  coach_can_remove_enrollments?: boolean;
  require_payment_proof: boolean;
  bank_name?: string | null;
  bank_account_type?: string | null;
  bank_account_number?: string | null;
  nequi_number?: string | null;
  daviplata_number?: string | null;
  bank_titular_name?: string | null;
  bank_titular_id?: string | null;
  payment_qr_url?: string | null;
  breb_number?: string | null;
  transfer_key?: string | null;
  /**
   * Llaves de pago de la escuela. Fuente única: es lo que ve el acudiente en su
   * modal y lo que el OCR acepta como destino del comprobante. Las columnas
   * sueltas de arriba quedan como espejo de la primera llave de cada tipo.
   */
  payment_accounts?: PaymentAccount[];
  allow_installments: boolean;
  max_installments_per_payment: number;
  min_installment_amount: number;
  installment_require_proof: boolean;
  billing_cycle_type: 'prorated' | 'fixed_calendar' | 'rolling_30';
  /** F7: alta a mitad de mes cobrando solo las clases restantes (mig 20261005214250). */
  remaining_classes_billing_enabled?: boolean;
  early_payment_discount_enabled: boolean;
  early_payment_discount_days: number;
  early_payment_discount_percentage: number;
  early_payment_discount_mode: 'days_from_creation' | 'day_of_month';
  /**
   * Descuento por hermanos (mig. 20260916101241). Automático: open_month lo
   * calcula solo desde el 2do hijo activo (mismo parent_id, misma escuela),
   * sin que nadie lo marque atleta por atleta. Ver
   * docs/specs/descuentos-hermanos-primos-referidos.md
   */
  sibling_discount_enabled: boolean;
  sibling_discount_percentage: number;
  /**
   * F2 hermanos escalonados: tiers[0] = % del 2.º hijo; el último vale para
   * todos los siguientes. NULL = se usa `sibling_discount_percentage`.
   */
  sibling_discount_tiers?: number[] | null;
  // Validación automática de comprobantes (Fase 5)
  auto_approve_enabled: boolean;
  auto_approve_max_amount: number;
  auto_glosa_enabled: boolean;
  /** Un solo toggle: correo al generarse el cobro del mes + correo al pasar los días de gracia sin pagar. */
  charge_notifications_enabled: boolean;
  // Avisos de cobranza independientes (migraciones 20261105115230 y 20261105115807). Opcionales: si la
  // migración no corrió en este ambiente, no existen y no se guardan.
  charge_created_notice_enabled?: boolean;
  collection_pre_due_enabled?: boolean;
  overdue_notices_enabled?: boolean;
  monthly_statement_enabled?: boolean;
  whatsapp_collection_reminders_enabled?: boolean;
  email_collection_reminders_enabled?: boolean;
  // Catálogos vendibles (20260908152538). SOLO LECTURA acá: el toggle es
  // control exclusivo del panel interno de SportMaps (AdminSubscriptionsPage),
  // esta página nunca lo escribe — un trigger en DB lo revertiría igual.
  merchandise_enabled: boolean;
  tournament_charges_enabled: boolean;
  /**
   * Pausa por vacaciones/lesión (mig. 20260910080206). Opt-in: apagado, nadie
   * puede pausar y `open_month` no cambia de comportamiento.
   * Ver docs/specs/pausa-vacaciones-enrollments.md
   */
  pause_enabled: boolean;
  pause_max_months_per_year: number;
  /** false deja solo el botón del admin: el acudiente no puede solicitarla. */
  pause_parent_can_request: boolean;
}


const DEFAULT_BILLING: Omit<BillingSettings, 'school_id'> = {
  payment_cutoff_day: 5,
  payment_grace_days: 5,
  auto_generate_payments: true,
  reminder_enabled: true,
  reminder_days_before: 3,
  late_fee_enabled: false,
  late_fee_percentage: 5,
  pause_enabled: false,
  pause_max_months_per_year: 2,
  pause_parent_can_request: true,
  allow_coach_messaging: true,
  // Default alineado con el de la columna en DB: es el comportamiento de siempre.
  coach_can_enroll_paid_teams: true,
  coach_can_upload_enrollment_forms: false,
  coach_can_upload_attendance_sheets: false,
  coach_can_remove_enrollments: false,
  require_payment_proof: true,
  allow_installments: true,
  max_installments_per_payment: 3,
  min_installment_amount: 10000,
  installment_require_proof: true,
  billing_cycle_type: 'prorated',
  early_payment_discount_enabled: false,
  early_payment_discount_days: 5,
  early_payment_discount_percentage: 0,
  early_payment_discount_mode: 'days_from_creation',
  sibling_discount_enabled: false,
  sibling_discount_percentage: 0,
  auto_approve_enabled: false,
  auto_approve_max_amount: 0,
  auto_glosa_enabled: false,
  charge_notifications_enabled: false,
  merchandise_enabled: false,
  tournament_charges_enabled: false,
  payment_accounts: [],
};


// ── Helper de OCR badge (mostrar match/no-match al admin) ────────────────────
type OcrStatus = 'match' | 'mismatch' | 'no_ocr';
function getOcrStatus(p: { amount: number; ocr_amount?: number | null }): OcrStatus {
  if (p.ocr_amount == null) return 'no_ocr';
  const diffPct = Math.abs(p.ocr_amount - p.amount) / Math.max(p.amount, 1) * 100;
  return diffPct <= 0.5 ? 'match' : 'mismatch';
}

function DestinoBadge({ payment }: { payment: { ocr_destination?: string | null; ocr_destination_name?: string | null } }) {
  const d = destinoDelComprobante(payment.ocr_destination_name, payment.ocr_destination);
  if (!d) return null;
  const tono = d.clave === 'giovani' ? 'bg-violet-50 text-violet-700 border-violet-200'
    : d.clave === 'milena' ? 'bg-pink-50 text-pink-700 border-pink-200'
    : 'bg-slate-50 text-slate-700 border-slate-200';
  return <Badge variant="outline" title="A quién se le pagó, según el comprobante" className={`text-[10px] ${tono}`}>→ {d.etiqueta}</Badge>;
}

function OcrMatchBadge({ payment }: { payment: { amount: number; ocr_amount?: number | null; ocr_bank?: string | null } }) {
  const status = getOcrStatus(payment);
  if (status === 'no_ocr') {
    return (
      <Badge variant="outline" className="text-[10px] bg-gray-50 text-gray-600 border-gray-200 py-0 h-5">
        Sin OCR
      </Badge>
    );
  }
  if (status === 'match') {
    return (
      <Badge variant="outline" className="text-[10px] bg-green-50 text-green-700 border-green-300 py-0 h-5">
        <CheckCircle2 className="h-2.5 w-2.5 mr-1" /> OCR ok {payment.ocr_bank ? `· ${payment.ocr_bank}` : ''}
      </Badge>
    );
  }
  // mismatch
  return (
    <Badge variant="outline" className="text-[10px] bg-red-50 text-red-700 border-red-300 py-0 h-5 font-semibold">
      <AlertTriangle className="h-2.5 w-2.5 mr-1" />
      OCR: {formatCurrency(payment.ocr_amount as number)} ≠ esperado
    </Badge>
  );
}

// Badge read-only del veredicto de reglas (modo sombra, Fase 2). Informativo:
// NO cambia la decisión de aprobar/rechazar — sirve para calibrar antes de activar.
// Motivo corto por código de regla, para que la fila diga POR QUÉ es amarillo
// sin abrir el comprobante. El texto completo queda en el title.
const VERDICT_REASON_SHORT: Record<string, string> = {
  MONTO_DIFIERE: 'Monto distinto',
  CAMPOS_ILEGIBLES: 'Datos ilegibles',
  DESTINO_AUSENTE: 'Sin cuenta destino',
  DESTINO_NO_COINCIDE: 'Otra cuenta destino',
  FECHA_FUERA_VENTANA: 'Fecha vieja',
  FECHA_FUTURA: 'Fecha futura',
  FORMATO_REFERENCIA: 'Referencia rara',
  IMAGEN_DUPLICADA: 'Imagen repetida',
  REFERENCIA_DUPLICADA: 'Referencia repetida',
  IS_TRANSACTION_LIST: 'Lista de movimientos',
  NOT_A_RECEIPT: 'No es comprobante',
  POSIBLE_MANIPULACION: 'Posible edición',
};

function VerdictBadge({ verdict, reasons }: { verdict?: string | null; reasons?: unknown[] | null }) {
  if (!verdict) return null;
  const cfg: Record<string, { label: string; className: string; dot: string; text: string }> = {
    verde: { label: 'Verde', className: 'bg-green-50 text-green-700 border-green-300', dot: 'bg-green-500', text: 'text-green-700' },
    amarillo: { label: 'Amarillo', className: 'bg-amber-50 text-amber-700 border-amber-300', dot: 'bg-amber-500', text: 'text-amber-700' },
    rojo: { label: 'Rojo', className: 'bg-red-50 text-red-700 border-red-300', dot: 'bg-red-500', text: 'text-red-700' },
  };
  const c = cfg[verdict];
  if (!c) return null;
  const list = (Array.isArray(reasons) ? reasons : []) as Array<{ code?: string; message?: string }>;
  const short = list.map((r) => (r.code && VERDICT_REASON_SHORT[r.code]) || null).filter(Boolean) as string[];
  const title = ['Veredicto automático de reglas (informativo, no decide)', ...list.map((r) => r.message).filter(Boolean)].join('\n');
  return (
    <div className="flex flex-col items-start gap-0.5" title={title}>
      <Badge variant="outline" className={`text-[10px] py-0 h-5 whitespace-nowrap gap-1 ${c.className}`}>
        <span className={`h-1.5 w-1.5 rounded-full ${c.dot}`} aria-hidden />
        {c.label}
      </Badge>
      {short.length > 0 && (
        <span className={`text-[10px] leading-tight ${c.text}`}>{short.join(' · ')}</span>
      )}
    </div>
  );
}

/** Pie de foto que mandó la familia por WhatsApp, citado tal cual. */
function FamilyNote({ note }: { note?: { pie: string } | null }) {
  if (!note?.pie) return null;
  return (
    <p className="mt-1 max-w-64 text-[11px] leading-snug text-slate-600 italic border-l-2 border-emerald-300 pl-2" title="Mensaje de la familia con el comprobante (WhatsApp)">
      «{note.pie}»
    </p>
  );
}

// ── Qué estados se traen del servidor ────────────────────────────────────────
// Estados que SIEMPRE se piden: los que representan plata reportada o un
// desenlace real. Los cobros emitidos y no pagados (pending/overdue sin
// comprobante) NO se traen: son cartera y ya viven en Finanzas. Eran el 98% de
// las filas de la escuela, y con `limit(100)` por created_at desplazaban los
// comprobantes reales fuera de la ventana: un comprobante por validar de
// Dynasty quedó en la posición ~362 de 499 y nunca llegaba al navegador.
// `glosado` va aquí sí o sí: es un comprobante EN DISCUSIÓN (create_glosa lo
// mueve a ese estado y lo saca de la cola de aprobación a propósito). Si no se
// trae, un pago reclamado desaparece de la pantalla — la misma fuga que este
// filtro viene a cerrar.
const CORE_STATUSES = ['paid', 'partial', 'rejected', 'awaiting_approval', 'glosado'] as const;

// Estados que solo se piden si el selector del Historial los pide explícitamente.
// `cancelled` son ~2.4k filas globales (cobros anulados por las limpiezas de
// duplicados): traerlas siempre reintroduce el problema de volumen.
// La lista completa de estados válidos la fija el CHECK payments_status_check
// (mig 20260717000002): pending, paid, overdue, failed, cancelled,
// awaiting_approval, rejected, partial, glosado. No existen refunded ni declined.
const OPT_IN_STATUSES = ['cancelled', 'overdue', 'pending', 'failed'] as const;

// Historial = movimientos con plata, con desenlace real, o en discusión abierta.
const HISTORY_DEFAULT_STATUSES = ['paid', 'partial', 'rejected', 'glosado'] as const;

// Rango del Historial: dos fechas exactas (desde / hasta), no bloques de meses.
// La pregunta operativa de la escuela es "¿qué entró HOY?", y un selector de
// "últimos 3 meses" no la responde. Se aplica en el SERVIDOR para acotar el
// volumen, en vez de un tope de filas que corta en silencio.
//
// LA FECHA QUE MANDA ES LA DEL PAGO (`payment_date`), no la de emisión del
// cobro: la mensualidad de agosto se emite el 30 de julio (batch `open_month`)
// y se paga en agosto. Filtrar por `created_at` metía los pagos de hoy en el
// bloque de julio. Cuando la fila no tiene fecha de pago propia se cae a
// `created_at`, que es lo único que hay.
const HISTORY_DEFAULT_RANGE_DAYS = 365;

/** 'YYYY-MM-DD' + n días. Aritmética de calendario pura, sin husos de por medio. */
function addDaysToDay(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/**
 * Medianoche hora Colombia de un 'YYYY-MM-DD', en ISO UTC — para comparar
 * contra `created_at`, que es `timestamptz`. 00:00 COT = 05:00Z del mismo día.
 * Se expresa en Z y no con offset `-05:00` para no meter signos en el valor de
 * un filtro de PostgREST.
 */
const dayStartUtc = (day: string) => `${day}T05:00:00.000Z`;

/** Día Colombia de un timestamp, para comparar contra un rango 'YYYY-MM-DD'. */
const dayInCO = (iso: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date(iso));

/**
 * Atajos del rango. `from`/`to` son funciones y no valores: el módulo se evalúa
 * una vez y la pestaña puede quedar abierta cruzando la medianoche, así que "Hoy"
 * tiene que resolverse en el clic.
 */
const HISTORY_QUICK_RANGES: { label: string; from: () => string; to: () => string }[] = [
  { label: 'Hoy', from: () => todayColombia(), to: () => todayColombia() },
  { label: 'Ayer', from: () => addDaysToDay(todayColombia(), -1), to: () => addDaysToDay(todayColombia(), -1) },
  { label: 'Este mes', from: () => `${todayColombia().slice(0, 7)}-01`, to: () => todayColombia() },
  { label: 'Último año', from: () => addDaysToDay(todayColombia(), -HISTORY_DEFAULT_RANGE_DAYS), to: () => todayColombia() },
];

/**
 * La consulta se trae por páginas hasta agotar las filas: la tabla tiene que
 * mostrar TODOS los movimientos del filtro. Con un `.limit(500)` fijo, Dynasty
 * (más de 500 movimientos en el año) veía "500 total / 499 pagado" y leía mal
 * su propia cartera. PostgREST corta cada respuesta en 1000 filas, por eso la
 * página es de ese tamaño.
 */
const HISTORY_PAGE_SIZE = 1000;
/** Red contra un bucle sin fin (50.000 filas), no un tope de negocio. */
const HISTORY_MAX_PAGES = 50;

const STATUS_CONFIG: Record<string, { label: string; className: string }> = {
  paid: { label: 'Pagado', className: 'bg-green-500 text-white border-transparent' },
  rejected: { label: 'Rechazado', className: 'bg-red-100 text-red-700 border-red-200' },
  awaiting_approval: { label: 'Por Validar', className: 'bg-amber-100 text-amber-700 border-amber-200' },
  overdue: { label: 'Vencido', className: 'bg-red-50 text-red-600 border-red-200' },
  failed: { label: 'Fallido', className: 'bg-gray-100 text-gray-600 border-gray-200' },
  cancelled: { label: 'Cancelado', className: 'bg-gray-100 text-gray-500 border-gray-200' },
  pending: { label: 'Pendiente', className: 'bg-yellow-50 text-yellow-700 border-yellow-200' },
  partial: { label: 'Abono parcial', className: 'bg-blue-50 text-blue-700 border-blue-200' },
  // Comprobante con glosa abierta: sale de la cola de aprobación y espera la
  // aclaración del acudiente. Sin esta entrada la tabla mostraba el string crudo.
  glosado: { label: 'En aclaración', className: 'bg-orange-100 text-orange-700 border-orange-200' },
};

interface PaymentTransaction {
  id: string;
  amount: number;
  amount_paid?: number | null;
  status: string;
  created_at: string;
  /** Fecha en que se hizo el pago, la declara quien lo reporta. Distinta de
   *  created_at, que es cuándo se EMITIÓ el cobro. */
  payment_date?: string | null;
  payment_method: string | null;
  payment_type: string | null;
  receipt_url: string | null;
  concept: string;
  team_id: string | null;
  parent: { full_name: string | null; email: string | null } | null;
  child: { full_name: string } | null;
  program: { name: string } | null;
  team: { name: string } | null;
  child_id?: string | null;
  parent_id?: string | null;
  user_id?: string | null;
  unregistered_athlete_id?: string | null;
  athlete_name?: string | null;
  parent_responsible?: string | null;
  plan?: { name: string } | null;
  early_payment_discount_applied?: number | null;
  // OCR del comprobante manual (LLM Vision). Null si no se logro leer o si es Wompi.
  ocr_amount?: number | null;
  ocr_currency?: string | null;
  ocr_date?: string | null;
  ocr_bank?: string | null;
  ocr_reference?: string | null;
  ocr_provider?: string | null;
  // Veredicto de reglas (modo sombra, Fase 2). Informativo.
  receipt_verdict?: string | null;
  ocr_destination?: string | null;
  ocr_destination_name?: string | null;
  receipt_verdict_reasons?: unknown[] | null;
  reconciliation_status?: string | null;
  /** Cuándo entró el comprobante (receipt_submitted_at; si falta, receipt_verdict_at). */
  submitted_at?: string | null;
  requires_review?: boolean | null;
  payment_category?: string | null;
  last_failure_reason?: string | null;
  period_already_settled?: boolean | null;
  // Señales para distinguir un pago gestionado por pasarela de uno manual.
  // OJO: payment_provider NO sirve solo — tiene DEFAULT 'wompi' en la columna
  // (mig 20260504000001), así que efectivo y transferencias también lo traen.
  payment_channel?: string | null;
  payment_provider?: string | null;
  wompi_reference?: string | null;
  wompi_transaction_id?: string | null;
  provider_transaction_id?: string | null;
  qr_id?: string | null;
  /** Sede del cobro (payments.branch_id). NULL = «Sin sede»: solo se ve en «Todas». */
  branch_id?: string | null;
  /** Prospecto que originó el cobro (clase de prueba, servicio vendido por el bot). */
  signup_lead_id?: string | null;
  /** Paga alguien que no es del club (prospecto sin ficha de deportista): insignia «Externo». */
  asiste_externo?: boolean;
}

// Devuelto por el RPC school_payment_kpis: agregados sobre TODO el histórico de
// la escuela. tx_count son transacciones reales (paid|partial), no cobros
// emitidos; approval_rate se calcula sobre intentos de pago y es null si no hubo.
interface PaymentKpis {
  revenue_total: number;
  tx_count: number;
  charges_total: number;
  awaiting_count: number;
  awaiting_amount: number;
  debt_count: number;
  debt_amount: number;
  attempts: number;
  approval_rate: number | null;
}

/** Una inscripción activa: a quién se le cobra, cuánto, y qué pasó este mes. */
interface TeamSubscription {
  id: string;
  full_name: string;
  child_id?: string | null;
  user_id?: string | null;
  unregistered_athlete_id?: string | null;
  team_id?: string | null;
  team_name?: string | null;
  /** Sede del equipo. `enrollments` no tiene sede propia; la hereda del equipo. */
  branch_id?: string | null;
  offering_plan_id?: string | null;
  plan_name?: string | null;
  /** Cuota que se le va a cobrar de verdad. Ver `effectiveFee`. */
  fee: number;
  /** De dónde salió la cuota, para poder explicar un $0 sin abrir la base. */
  fee_source: 'enrollment' | 'plan' | 'team' | 'none';
  /**
   * Precio del plan HOY, para detectar tarifa congelada (docs/plan-tarifa-congelada-c12.md,
   * fase F1). Cuando `fee_source === 'enrollment'` y este valor difiere de `fee`, la
   * inscripción quedó en el precio que tenía el plan al momento de inscribirse — el
   * catálogo subió después y no le cascadeó. `null` si el plan no tiene precio propio.
   */
  plan_price_now: number | null;
  start_date: string;
  /** Cobro del mes en curso si existe. `null` = no se le generó nada. */
  charge: {
    status: string;
    due_date: string | null;
    amount: number;
    /** Último intento de pago que se cayó. Se muestra junto al estado del cobro. */
    last_failure_at: string | null;
    last_failure_reason: string | null;
    /** ERROR/VOIDED sin resolver: no sabemos si el dinero se movió. */
    requires_review: boolean;
  } | null;
  /**
   * Cobros únicos del mes sin pagar (inscripción, seguro, excedente). Son filas
   * aparte de la mensualidad: `charge` representa solo a la mensualidad.
   */
  one_off_due: { label: string; amount: number }[];
  /** Deuda de meses ANTERIORES que sigue sin pagar. */
  arrears: { count: number; amount: number } | null;
  /** Atleta al que pertenece la fila. Para no sumar su deuda dos veces. */
  athlete_key: string | null;
}

/**
 * Cuota efectiva de una inscripción, en el MISMO orden que usa el resto del
 * sistema al cobrar: `enrollments.monthly_fee` manda, el plan es el respaldo y
 * el precio del equipo es el último recurso.
 *
 * Esta pantalla leía `teams.price_monthly` de una: en Dynasty está en 0 para
 * todos los equipos, así que 419 de 422 filas mostraban $0 — $57.5M de
 * mensualidad invisible — mientras el monto real estaba en `monthly_fee`.
 */
function effectiveFee(e: {
  monthly_fee?: number | null;
  plan?: { price?: number | null } | null;
  team?: { price_monthly?: number | null } | null;
}): { fee: number; source: TeamSubscription['fee_source'] } {
  const own = Number(e.monthly_fee) || 0;
  if (own > 0) return { fee: own, source: 'enrollment' };
  const plan = Number(e.plan?.price) || 0;
  if (plan > 0) return { fee: plan, source: 'plan' };
  const team = Number(e.team?.price_monthly) || 0;
  if (team > 0) return { fee: team, source: 'team' };
  return { fee: 0, source: 'none' };
}

/**
 * Cuál de los cobros del mes representa a la inscripción cuando hay varios.
 * Gana el que está más avanzado: si ya hay uno pagado, la fila está pagada
 * aunque arrastre otro pendiente de una segunda categoría.
 */
const CHARGE_PRIORITY: Record<string, number> = {
  paid: 0, partial: 1, awaiting_approval: 2, glosado: 3, pending: 4, overdue: 5, rejected: 6, failed: 7,
};

export default function PaymentsAutomationPage() {
  const { profile, user } = useAuth();
  const { toast } = useToast();
  // En celular la burbuja de Mapi tapaba «Aprobar» / «Comprobante» de cada cobro.
  useOcultarFabSoporte(useIsMobile());
  const { schoolId, schoolName, activeBranchId, currentUserRole, branches, totalBranches } = useSchoolContext();
  // Multisede: con más de una sede se muestra la columna Sede y lo que no
  // tiene sede solo aparece en «Todas» (mismo criterio que la consulta de cobros).
  const showBranchCol = totalBranches > 1;
  const inActiveBranch = (branchId?: string | null) =>
    !activeBranchId || branchId === activeBranchId || (!branchId && totalBranches <= 1);
  // «Cobros y pagos» (docs/specs/cobros-multiples.md F3). Apagado = «Registrar pago» de siempre.
  const cobrosYPagosOn = isCobrosYPagosEnabled();
  const showRegisterButton = !cobrosYPagosOn || canManageCharges(currentUserRole);
  const showOperacionesTab = cobrosYPagosOn && canReadChargeBatches(currentUserRole);
  // Deep-link a un tab puntual (ej. "Próximo Cierre de Mes" en Finanzas manda
  // acá a abrir el mes — sin esto, quien llega desde ese link caía siempre en
  // "Cobros" y el botón de abrir mes, que vive en "Config", quedaba invisible.
  const [searchParams, setSearchParams] = useSearchParams();
  const PAYMENTS_TABS = ['recurrent', 'teams', 'glosas', 'conciliacion', 'history', 'cierre', 'debito', 'config', 'operaciones'] as const;
  const tabParam = searchParams.get('tab');
  const activeTab = (PAYMENTS_TABS as readonly string[]).includes(tabParam || '') ? tabParam! : 'recurrent';
  // Se incrementa al conectar/quitar una pasarela: remonta SportMaps Pay para
  // que su gate vuelva a preguntar si ya hay cuenta de recaudo.
  const [revisionPasarelas, setRevisionPasarelas] = useState(0);
  // Mismo criterio que AppSidebar. El BFF autoriza a los mismos en
  // isAdminGlobal(), para no mostrar un formulario que devuelve 403.
  const esPlatformAdmin = profile?.role === 'admin' || profile?.role === 'super_admin';
  const [loading, setLoading] = useState(true);
  const [payments, setPayments] = useState<PaymentTransaction[]>([]);
  // Lo que la familia escribió con la foto por WhatsApp («envío saldo sept 15 -
  // oct 15»), por cobro. Vive en la cola del bot, no en `payments`: sin esto la
  // escuela aprobaba sin ver la explicación (Dynasty 2026-10-09).
  const [familyNotes, setFamilyNotes] = useState<Record<string, { pie: string; recibido_at: string | null }>>({});
  const [historyTruncated, setHistoryTruncated] = useState(false);
  // KPIs agregados en DB (school_payment_kpis). NO se derivan de `payments`:
  // esa lista está paginada a 100 filas y calcular las tarjetas sobre ella
  // mostraba "Histórico acumulado" de solo las últimas horas.
  const [kpis, setKpis] = useState<PaymentKpis | null>(null);
  const [teamSubscriptions, setTeamSubscriptions] = useState<TeamSubscription[]>([]);
  // `group`: el comprobante paga varios cobros de la cola (mismo receipt_url).
  const [viewingProof, setViewingProof] = useState<{ open: boolean; url: string; student: string; amount: number; group?: string | null }>({
    open: false, url: '', student: '', amount: 0,
  });
  // Rechazo de comprobante (con motivo) y aprobación en lote de los verdes.
  const [rejectingPayment, setRejectingPayment] = useState<PaymentTransaction | null>(null);
  const [bulkGreensOpen, setBulkGreensOpen] = useState(false);
  // Reloj de la cola: refresca el «esperando hace…» cada minuto.
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  // Glosas (aclaraciones) de la escuela.
  const [glosas, setGlosas] = useState<Glosa[]>([]);
  const [conciliatingGlosa, setConciliatingGlosa] = useState<Glosa | null>(null);
  const [creatingGlosaPayment, setCreatingGlosaPayment] = useState<PaymentTransaction | null>(null);
  const [billing, setBilling] = useState<BillingSettings | null>(null);
  // ¿Este ambiente ya tiene la columna payment_accounts? Se resuelve al cargar.
  const accountsColumnReady = useRef(false);
  const coachPhotoColumnsReady = useRef(false);
  const coachRemoveColumnReady = useRef(false);
  const remainingClassesColumnReady = useRef(false);
  // Escalones de hermanos (F2): si la columna no existe aún en este ambiente,
  // mandarla tumbaría el upsert completo.
  const siblingTiersColumnReady = useRef(false);
  const avisosColumnsReady = useRef(false);
  const [billingSaving, setBillingSaving] = useState(false);
  const [showSensitive, setShowSensitive] = useState(false);

  // Filtros Historial y Equipos
  const [historySearch, setHistorySearch] = useState('');
  const [historyStatusFilter, setHistoryStatusFilter] = useState('all');
  const [historyTeamFilter, setHistoryTeamFilter] = useState('all');
  // Tipo de cobro (mensualidad, inscripción, torneo…). Sin esto todo salía
  // mezclado y la escuela no podía revisar solo lo que entró por torneos.
  const [historyCategoryFilter, setHistoryCategoryFilter] = useState<string>(TODOS_LOS_TIPOS);
  // Rango por fecha del pago. Arranca en el último año para no cambiar de golpe
  // lo que la escuela ya veía al entrar; los atajos de abajo lo acotan a un día.
  const [historyFrom, setHistoryFrom] = useState(() => addDaysToDay(todayColombia(), -HISTORY_DEFAULT_RANGE_DAYS));
  const [historyTo, setHistoryTo] = useState(() => todayColombia());
  const [historyPage, setHistoryPage] = useState(1);
  // Filas por página de la TABLA del historial. No confundir con HISTORY_PAGE_SIZE
  // (módulo, 1000): con el mismo nombre esta tapaba aquella y fetchPayments
  // bajaba los cobros de a 10 — 65 peticiones en serie para Dynasty.
  const HISTORY_ROWS_PER_VIEW = 10;

  // Filtros "Equipos y Planes". Antes pintaba las 855 filas de una, sin buscador
  // ni orden: para encontrar a alguien había que usar Ctrl+F del navegador.
  const [subsSearch, setSubsSearch] = useState('');
  const [subsTeamFilter, setSubsTeamFilter] = useState('all');
  const [subsSort, setSubsSort] = useState<'name' | 'fee' | 'urgency'>('name');
  const [subsPage, setSubsPage] = useState(1);
  const SUBS_PAGE_SIZE = 15;

  // Filtros Validación (Pendientes)
  const [pendingSearch, setPendingSearch] = useState('');
  // Tipo de cobro en la cola (Mensualidad, Clínica, Torneo…). Solo filtra lo
  // que se VE: «Aprobar todos los verdes» sigue trabajando sobre toda la cola.
  const [pendingTipoFilter, setPendingTipoFilter] = useState<string>(TODOS_LOS_TIPOS);

  // Estados para Cash Payments
  const [showCashModal, setShowCashModal] = useState(false);
  // «Clases de prueba»: cobro del prospecto en sede (mig. 20261029215003).
  const [showClasesPrueba, setShowClasesPrueba] = useState(false);
  const [paymentToApprove, setPaymentToApprove] = useState<PaymentTransaction | null>(null);

  // Equipos activos para filtros
  const [activeTeams, setActiveTeams] = useState<{ id: string; name: string }[]>([]);

  // Reset de la paginación del historial cuando cambian los filtros
  useEffect(() => { setHistoryPage(1); }, [historySearch, historyStatusFilter, historyTeamFilter, historyCategoryFilter, historyFrom, historyTo]);
  useEffect(() => { setSubsPage(1); }, [subsSearch, subsTeamFilter, subsSort, activeBranchId]);

  useEffect(() => {
    const teamsMap = new Map();
    payments.forEach(p => p.team?.name && teamsMap.set(p.team.name, { id: p.team_id, name: p.team.name }));
    teamSubscriptions.forEach(t => t.team_name && teamsMap.set(t.team_name, { id: t.team_id, name: t.team_name }));
    setActiveTeams(Array.from(teamsMap.values()).sort((a, b) => a.name.localeCompare(b.name)));
  }, [payments, teamSubscriptions]);

  useEffect(() => {
    if (schoolId) {
      loadBillingSettings();
      fetchPayments();
      loadTeamSubscriptions();
      fetchGlosas();
    }
  }, [schoolId, activeBranchId]);

  // El conteo de sedes llega async (selectSchool) DESPUÉS de activeBranchId:
  // un admin de sede que carga con totalBranches=0 vería también los cobros sin
  // sede. Al conocerse el conteo, se recarga la lista (solo si hay sede elegida).
  useEffect(() => {
    if (schoolId && activeBranchId) fetchPayments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totalBranches]);

  // Los estados opt-in (hoy solo 'Cancelado') no vienen en la carga base, así
  // que elegirlos exige volver a consultar. Se salta el primer render para no
  // duplicar el fetch del efecto de arriba.
  const extraStatusRequested = (OPT_IN_STATUSES as readonly string[]).includes(historyStatusFilter)
    ? historyStatusFilter
    : null;
  const didMountRef = useRef(false);
  useEffect(() => {
    if (!didMountRef.current) { didMountRef.current = true; return; }
    if (schoolId) fetchPayments();
  }, [extraStatusRequested, historyFrom, historyTo]);

  const fetchGlosas = async () => {
    if (!schoolId) return;
    try {
      const rows = await listSchoolGlosas();
      setGlosas(rows);
    } catch {
      setGlosas([]);
    }
  };

  const loadBillingSettings = async () => {
    if (!schoolId) return;
    const { data } = await supabase.from('school_settings').select('*').eq('school_id', schoolId).maybeSingle();
    if (!data) {
      setBilling({ ...DEFAULT_BILLING, school_id: schoolId });
      return;
    }
    // El select('*') delata si la migración 20260809095613 ya corrió en este
    // ambiente. Si la columna no está, guardar mandándola tumbaría el upsert
    // completo y la escuela no podría salvar NINGÚN ajuste de cobro.
    accountsColumnReady.current = 'payment_accounts' in data;
    // Mismo cuidado con los permisos de fotos del coach (mig 20261005120806).
    coachPhotoColumnsReady.current = 'coach_can_upload_enrollment_forms' in data;
    coachRemoveColumnReady.current = 'coach_can_remove_enrollments' in data;
    // Y con el cobro por clases restantes (mig 20261005214250).
    remainingClassesColumnReady.current = 'remaining_classes_billing_enabled' in data;
    siblingTiersColumnReady.current = 'sibling_discount_tiers' in data;
    avisosColumnsReady.current = 'overdue_notices_enabled' in data && 'collection_pre_due_enabled' in data;
    // `onlyActive: false` porque el admin también edita las llaves apagadas. Si la
    // escuela nunca guardó la lista (deploy recién hecho), se arma desde las
    // columnas viejas para que no vea el formulario en blanco teniendo datos.
    setBilling({
      ...(data as unknown as BillingSettings),
      payment_accounts: resolvePaymentAccounts(data as LegacyAccountColumns & { payment_accounts?: unknown }, { onlyActive: false }),
    });
  };

  const handleSaveBilling = async () => {
    if (!billing || !schoolId) return;
    // Un link de pago mal escrito no se guarda: el BFF y el checkout lo
    // ignorarían en silencio y la escuela creería que está publicado.
    const linkMalo = (billing.payment_accounts ?? []).find(a => isPaymentLink(a) && a.value.trim() && !isValidPaymentLinkUrl(a.value));
    if (linkMalo) {
      toast({
        title: 'Revisa el link de pago',
        description: 'Debe ser una dirección https completa, por ejemplo https://checkout.wompi.co/l/…',
        variant: 'destructive',
      });
      return;
    }
    setBillingSaving(true);
    try {
      // La lista manda: las columnas sueltas se reescriben con la primera llave
      // activa de cada tipo para no dejar datos viejos contradiciendo lo que el
      // acudiente ve y lo que el OCR compara.
      const accounts = serializePaymentAccounts(billing.payment_accounts ?? []);
      const payload = {
        school_id: schoolId,
        // `payment_accounts` es jsonb en la base: PaymentAccount[] no es asignable
        // a Json (los campos opcionales admiten undefined, que no existe en JSON).
        // El JSON.parse/stringify normaliza y a la vez tira los undefined.
        ...(accountsColumnReady.current
            ? { payment_accounts: JSON.parse(JSON.stringify(accounts)) }
            : {}),
        ...accountsToLegacyColumns(accounts),
        payment_cutoff_day: billing.payment_cutoff_day,
        payment_grace_days: billing.payment_grace_days,
        auto_generate_payments: billing.auto_generate_payments,
        reminder_enabled: billing.reminder_enabled,
        reminder_days_before: billing.reminder_days_before,
        late_fee_enabled: billing.late_fee_enabled,
        late_fee_percentage: billing.late_fee_percentage,
        pause_enabled: billing.pause_enabled,
        pause_max_months_per_year: billing.pause_max_months_per_year,
        pause_parent_can_request: billing.pause_parent_can_request,
        allow_coach_messaging: billing.allow_coach_messaging,
        coach_can_enroll_paid_teams: billing.coach_can_enroll_paid_teams,
        ...(coachPhotoColumnsReady.current
            ? {
                coach_can_upload_enrollment_forms: !!billing.coach_can_upload_enrollment_forms,
                coach_can_upload_attendance_sheets: !!billing.coach_can_upload_attendance_sheets,
              }
            : {}),
        ...(coachRemoveColumnReady.current
            ? { coach_can_remove_enrollments: !!billing.coach_can_remove_enrollments }
            : {}),
        require_payment_proof: billing.require_payment_proof,
        bank_name: billing.bank_name,
        // El <select> de tipo de cuenta tiene un placeholder con value="" (línea
        // ~2977): sin normalizar, "" viola school_settings_bank_account_type_check
        // (NULL o ahorros/corriente/billetera_digital) y tumba TODO el upsert.
        bank_account_type: billing.bank_account_type || null,
        bank_account_number: billing.bank_account_number,
        bank_titular_name: billing.bank_titular_name,
        bank_titular_id: billing.bank_titular_id,
        payment_qr_url: billing.payment_qr_url,
        billing_cycle_type: billing.billing_cycle_type,
        ...(remainingClassesColumnReady.current
            ? { remaining_classes_billing_enabled: !!billing.remaining_classes_billing_enabled }
            : {}),
        allow_installments: billing.allow_installments,
        max_installments_per_payment: billing.max_installments_per_payment,
        min_installment_amount: billing.min_installment_amount,
        installment_require_proof: billing.installment_require_proof,
        early_payment_discount_enabled: billing.early_payment_discount_enabled,
        early_payment_discount_days: billing.early_payment_discount_days,
        early_payment_discount_percentage: billing.early_payment_discount_percentage,
        early_payment_discount_mode: billing.early_payment_discount_mode,
        sibling_discount_enabled: billing.sibling_discount_enabled,
        // Los escalones mandan: el % plano queda igual al del 2.º hijo (el
        // trigger de la base hace lo mismo; se manda igual por si no está).
        ...(siblingTiersColumnReady.current
            ? (() => {
                const tiers = normalizeSiblingTiers(billing.sibling_discount_tiers, billing.sibling_discount_percentage);
                return { sibling_discount_tiers: tiers, sibling_discount_percentage: tiers[0] };
              })()
            : { sibling_discount_percentage: billing.sibling_discount_percentage }),
        auto_approve_enabled: billing.auto_approve_enabled,
        auto_approve_max_amount: billing.auto_approve_max_amount,
        auto_glosa_enabled: billing.auto_glosa_enabled,
        charge_notifications_enabled: billing.charge_notifications_enabled,
        ...(avisosColumnsReady.current
          ? {
              charge_created_notice_enabled: billing.charge_created_notice_enabled !== false,
              collection_pre_due_enabled: billing.collection_pre_due_enabled !== false,
              overdue_notices_enabled: billing.overdue_notices_enabled !== false,
              monthly_statement_enabled: billing.monthly_statement_enabled !== false,
              whatsapp_collection_reminders_enabled: billing.whatsapp_collection_reminders_enabled === true,
              email_collection_reminders_enabled: billing.email_collection_reminders_enabled === true,
            }
          : {}),
      };

      const { error } = await supabase.from('school_settings').upsert(payload as any, { onConflict: 'school_id' });
      if (error) throw error;
      toast({ title: '✅ Configuración de pagos guardada' });
    } catch (err: any) {
      toast({ title: 'Error al guardar', description: getUserFriendlyError(err), variant: 'destructive' });
    } finally {
      setBillingSaving(false);
    }
  };

  const updateBilling = <K extends keyof BillingSettings>(key: K, value: BillingSettings[K]) => {
    if (billing) setBilling({ ...billing, [key]: value });
  };  const fetchPayments = async () => {
    if (!schoolId) return;
    setLoading(true);
    try {
      // El estado se filtra en el SERVIDOR. Antes se pedían las 100 filas más
      // recientes y se repartían en el cliente entre cola e historial: con 355
      // cobros de cartera creados después, los comprobantes por validar no
      // entraban en esas 100 y la escuela no tenía forma de verlos.
      const extraStatus = (OPT_IN_STATUSES as readonly string[]).includes(historyStatusFilter)
        ? [historyStatusFilter]
        : [];
      const statuses = [...CORE_STATUSES, ...extraStatus].join(',');

      const buildQuery = () => {
      let query = supabase
        .from('payments')
        .select(`
          id, amount, amount_paid, status, created_at, payment_date, payment_method, payment_type,
          receipt_url, concept, child_id, parent_id, user_id, team_id, branch_id,
          unregistered_athlete_id, early_payment_discount_applied, signup_lead_id,
          period_year, period_month, payment_category,
          payment_channel, payment_provider, wompi_reference, wompi_transaction_id,
          provider_transaction_id, qr_id,
          ocr_amount, ocr_currency, ocr_date, ocr_bank, ocr_reference, ocr_provider,
          receipt_verdict, ocr_destination, ocr_destination_name, receipt_verdict_reasons, reconciliation_status,
          receipt_verdict_at,
          requires_review, last_failure_at, last_failure_reason,
          parent:profiles!payments_parent_id_fkey(full_name, email),
          user:profiles!payments_user_id_fkey(full_name, email),
          child:children!payments_child_id_fkey(full_name),
          team:teams!payments_team_id_fkey(name),
          plan:offering_plans!payments_offering_plan_id_fkey(name)
        `)
        .eq('school_id', schoolId)
        // El segundo término es defensivo: si algún día un cobro pending/overdue
        // recibe comprobante sin pasar por awaiting_approval, igual se ve.
        .or(`status.in.(${statuses}),and(status.in.(pending,overdue),receipt_url.not.is.null)`)
        .order('created_at', { ascending: false })
        // Desempate estable: sin él, dos filas con el mismo created_at pueden
        // saltar de página y salir repetidas o no salir.
        .order('id', { ascending: false });

      // Rango de fechas, también en el servidor. Se compara contra `payment_date`
      // (columna `date`, se compara pelada) y, solo cuando esa está en NULL,
      // contra `created_at` (`timestamptz`, se compara con los límites del día
      // en hora Colombia).
      //
      // Los comprobantes por validar NUNCA se recortan por fecha: si uno viejo
      // sigue esperando aprobación tiene que verse, y esconderlo por antigüedad
      // es justo el bug que dejó uno de Dynasty invisible. Esa exención es para
      // la COLA; el Historial sí respeta el rango exacto, y lo aplica en cliente
      // sobre estas mismas filas (ver `inHistoryRange`).
      if (historyFrom || historyTo) {
        const byPaymentDate = ['payment_date.not.is.null'];
        const byCreatedAt = ['payment_date.is.null'];
        if (historyFrom) {
          byPaymentDate.push(`payment_date.gte.${historyFrom}`);
          byCreatedAt.push(`created_at.gte.${dayStartUtc(historyFrom)}`);
        }
        if (historyTo) {
          byPaymentDate.push(`payment_date.lte.${historyTo}`);
          // Límite superior EXCLUSIVO al arranque del día siguiente: con `lte`
          // sobre el mismo día se perdía todo lo del día "hasta" después de las
          // 00:00, que es todo.
          byCreatedAt.push(`created_at.lt.${dayStartUtc(addDaysToDay(historyTo, 1))}`);
        }
        query = query.or(
          `and(${byPaymentDate.join(',')}),and(${byCreatedAt.join(',')}),status.in.(awaiting_approval,partial,glosado)`,
        );
      }

      // Sede (multisede S1, docs/specs/multisede-selector-y-sede-del-atleta.md):
      // con una sede elegida solo salen los cobros de ESA sede. Un cobro sin
      // sede no se reparte en todas: se ve en «Todas» con la etiqueta «Sin
      // sede». Excepción: escuela de UNA sola sede (Dynasty: 207 de 499 sin
      // sede) — ahí NULL es implícitamente esa sede, como en la vista
      // school_athletes (get_single_branch_id), y se sigue viendo.
      if (activeBranchId) {
        query = totalBranches > 1
          ? query.eq('branch_id', activeBranchId)
          : query.or(`branch_id.is.null,branch_id.eq.${activeBranchId}`);
      }
      return query;
      };

      const data: any[] = [];
      let truncated = false;
      for (let page = 0; ; page++) {
        if (page >= HISTORY_MAX_PAGES) { truncated = true; break; }
        const from = page * HISTORY_PAGE_SIZE;
        const { data: rows, error } = await buildQuery().range(from, from + HISTORY_PAGE_SIZE - 1);
        if (error) throw error;
        data.push(...(rows || []));
        if (!rows || rows.length < HISTORY_PAGE_SIZE) break;
      }
      setHistoryTruncated(truncated);

      // Resolver nombres de atletas sin cuenta (unregistered)
      const unregisteredIds = (data || [])
        .filter((p: any) => p.unregistered_athlete_id)
        .map((p: any) => p.unregistered_athlete_id);

      const unregisteredMap = new Map<string, string>();
      if (unregisteredIds.length > 0) {
        // En lotes: con todos los movimientos cargados la lista de ids puede
        // ser larga, y un `in` con cientos de uuid excede el largo de la URL.
        const uniqueIds = [...new Set(unregisteredIds)];
        for (let i = 0; i < uniqueIds.length; i += 150) {
          const { data: unregistered } = await (supabase
            .from('unregistered_athletes') as any)
            .select('id, full_name')
            .in('id', uniqueIds.slice(i, i + 150));
          (unregistered || []).forEach((u: any) => unregisteredMap.set(u.id, u.full_name));
        }
      }

      // Set de periodos ya cubiertos (paid/approved) por hijo, para marcar
      // duplicados visibles cuando un comprobante pendiente apunta a un mes
      // ya pagado. Clave: `${child_id}|${year}|${month}`.
      const settledPeriods = new Set<string>();
      (data as any[] | null)?.forEach((p) => {
        if (p.child_id && p.period_year && p.period_month && (p.status === 'paid' || p.status === 'approved')) {
          settledPeriods.add(`${p.child_id}|${p.period_year}|${p.period_month}`);
        }
      });

      const monthLabel = (y?: number | null, m?: number | null): string | null =>
        y && m && m >= 1 && m <= 12
          ? `${['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'][m - 1]} ${y}`
          : null;

      // Cuándo entró cada comprobante por validar. `receipt_submitted_at` llega
      // con la migración 20261008165728; va en una consulta aparte para que, sin
      // ella, la pantalla siga cargando (con `receipt_verdict_at` de respaldo).
      const awaitingIds = ((data as any[]) || [])
        .filter((p) => p.status === 'awaiting_approval')
        .map((p) => p.id as string);
      const submittedAt = new Map<string, string>();
      for (let i = 0; i < awaitingIds.length; i += 150) {
        const { data: sub, error: subErr } = await (supabase.from('payments') as any)
          .select('id, receipt_submitted_at')
          .in('id', awaitingIds.slice(i, i + 150));
        if (subErr) break;
        for (const r of (sub as any[]) ?? []) if (r.receipt_submitted_at) submittedAt.set(r.id, r.receipt_submitted_at);
      }

      setPayments(((data as any[]) || []).map((p) => {
        // Nombre del atleta resuelto por tipo. Si el cobro no tiene a nadie del
        // club (prospecto: clase de prueba, clínica o torneo vendidos por el
        // bot), el nombre va en el concepto «<servicio> — <quien asiste>»; antes
        // solo se sacaba para la clase de prueba y la clínica salía «Sin nombre».
        const asiste = nombreDeQuienAsiste({
          ...p,
          athlete_name:
            p.child?.full_name ||
            ((p.user_id || p.parent_id) && !p.child_id ? (p.user?.full_name || p.parent?.full_name) : null) ||
            (p.unregistered_athlete_id ? unregisteredMap.get(p.unregistered_athlete_id) : null) ||
            null,
        });
        return {
        id: p.id, amount: p.amount, amount_paid: p.amount_paid, status: p.status, created_at: p.created_at,
        // `payment_date` se pedía al servidor pero se caía acá: la columna Fecha
        // y el CSV llevaban meses mostrando `created_at` (la EMISIÓN del cobro)
        // por el fallback de `reportedDate`. Un pago aprobado hoy sobre una
        // mensualidad emitida el 30/jul se leía como "30 de jul".
        payment_date: p.payment_date ?? null,
        payment_method: p.payment_method, payment_type: p.payment_type,
        receipt_url: p.receipt_url, concept: p.concept,
        payment_category: p.payment_category ?? null,
        child_id: p.child_id, parent_id: p.parent_id, user_id: p.user_id,
        team_id: p.team_id,
        branch_id: p.branch_id ?? null,
        payment_channel: p.payment_channel ?? null,
        payment_provider: p.payment_provider ?? null,
        wompi_reference: p.wompi_reference ?? null,
        wompi_transaction_id: p.wompi_transaction_id ?? null,
        provider_transaction_id: p.provider_transaction_id ?? null,
        qr_id: p.qr_id ?? null,
        unregistered_athlete_id: p.unregistered_athlete_id,
        early_payment_discount_applied: p.early_payment_discount_applied,
        ocr_amount: p.ocr_amount, ocr_currency: p.ocr_currency,
        ocr_date: p.ocr_date, ocr_bank: p.ocr_bank,
        ocr_reference: p.ocr_reference, ocr_provider: p.ocr_provider,
        receipt_verdict: p.receipt_verdict ?? null,
        ocr_destination: p.ocr_destination ?? null,
        ocr_destination_name: p.ocr_destination_name ?? null,
        receipt_verdict_reasons: p.receipt_verdict_reasons ?? null,
        reconciliation_status: p.reconciliation_status ?? null,
        submitted_at: submittedAt.get(p.id) ?? p.receipt_verdict_at ?? null,
        requires_review: p.requires_review ?? null,
        last_failure_reason: p.last_failure_reason ?? null,
        period_year:  p.period_year ?? null,
        period_month: p.period_month ?? null,
        // Solo la mensualidad «cubre» un mes: un torneo o un uniforme no (aunque
        // tenga periodo por su fecha de cobro).
        period_label: isMensualidad(p.payment_category) ? monthLabel(p.period_year, p.period_month) : null,
        // Solo marcamos duplicado en pendientes que reclaman un periodo
        // ya saldado por OTRO pago (no por si mismo).
        period_already_settled:
          p.status === 'awaiting_approval' &&
          p.child_id && p.period_year && p.period_month &&
          settledPeriods.has(`${p.child_id}|${p.period_year}|${p.period_month}`),
        // Nombre del atleta (ver `asiste` arriba). La tabla del prospecto no se
        // lee desde el navegador: para él, el nombre sale del concepto.
        athlete_name: asiste.nombre,
        asiste_externo: asiste.externo,
        signup_lead_id: p.signup_lead_id ?? null,
        // Padre/responsable solo si es diferente al atleta (menores)
        parent_responsible: p.child_id ? (p.parent?.full_name || null) : null,
        parent: p.parent,
        child: p.child,
        program: null,
        team: p.team,
        plan: p.plan,
        };
      }));

      // Pies de foto del bot. Informativo: si el BFF falla o aún no tiene la
      // ruta, la cola se ve igual que antes.
      const noteIds = ((data as any[]) || [])
        .filter((p) => p.receipt_url && (p.status === 'awaiting_approval' || p.status === 'partial'))
        .map((p) => p.id as string)
        .slice(0, 100);
      if (noteIds.length) {
        bffClient.get<{ notas: Record<string, { pie: string; recibido_at: string | null }> }>(
          `/api/v1/whatsapp/${schoolId}/notas-de-comprobantes?payment_ids=${noteIds.join(',')}`,
        ).then((r) => setFamilyNotes(r?.notas ?? {}), () => setFamilyNotes({}));
      } else {
        setFamilyNotes({});
      }
    } catch (error: unknown) {
      toast({ title: 'Error al cargar pagos', description: getUserFriendlyError(error), variant: 'destructive' });
    } finally {
      setLoading(false);
      // Se refrescan junto con la lista para que aprobar/rechazar un cobro
      // actualice las tarjetas sin tocar los 5 call sites de fetchPayments.
      void fetchKpis();
    }
  };

  // KPIs del histórico completo. Va por RPC y no por la lista paginada: la lista
  // trae 100 filas y las tarjetas tienen que hablar de TODO el histórico.
  const fetchKpis = async () => {
    if (!schoolId) return;
    const { data, error } = await (supabase as any).rpc('school_payment_kpis', {
      p_school_id: schoolId,
      p_branch_id: activeBranchId || null,
    });
    if (error) {
      // No reventamos la pantalla por las tarjetas: la lista de cobros es lo
      // operativo. kpis en null hace que se muestre '—' en vez de un dato falso.
      setKpis(null);
      return;
    }
    setKpis(data as PaymentKpis);
  };

  const loadTeamSubscriptions = async () => {
    if (!schoolId) return;
    try {
      const { data, error } = await (supabase
        .from('enrollments') as any)
        .select(`
          id, child_id, user_id, unregistered_athlete_id,
          team_id, offering_plan_id,
          monthly_fee,
          start_date,
          team:teams!enrollments_team_id_fkey ( name, price_monthly, branch_id ),
          plan:offering_plans!enrollments_offering_plan_id_fkey ( name, price )
        `)
        .eq('school_id', schoolId)
        .eq('status', 'active');

      if (error) throw error;

      // ─── OPTIMIZACIÓN: Fetch en bloque ─────────────────────────────────────
      const rawEnrollments = (data as any[]) || [];
      if (rawEnrollments.length === 0) {
        setTeamSubscriptions([]);
        return;
      }

      const childIds = rawEnrollments.map(e => e.child_id).filter(Boolean);
      const userIds  = rawEnrollments.map(e => e.user_id).filter(Boolean);
      const unregIds = rawEnrollments.map(e => e.unregistered_athlete_id).filter(Boolean);

      // 1. Atletas (BFF para menores - soporta multi-school)
      const childrenData = childIds.length > 0
        ? await bffClient.post<any[]>(`/api/v1/students/children-by-ids`, { ids: childIds }, { 'x-school-id': schoolId })
        : [];
      const childMap = new Map<string, string>((childrenData ?? []).map(c => [c.id, c.full_name]));

      const { data: profiles } = userIds.length > 0
        ? await supabase.from('profiles').select('id, full_name').in('id', userIds)
        : { data: [] };
      const profileMap = new Map<string, string>((profiles ?? []).map(p => [p.id, p.full_name]));

      const { data: unreg } = unregIds.length > 0
        ? await (supabase.from('unregistered_athletes') as any).select('id, full_name').in('id', unregIds)
        : { data: [] };
      const unregMap = new Map<string, string>((unreg ?? []).map(u => [u.id, u.full_name]));

      // ─── Cobro del mes en curso, por atleta ────────────────────────────────
      // Sin esto la columna "Próximo Cobro" era la etiqueta `Día N (Prox. Mes)`
      // repetida idéntica en todas las filas: la config de la escuela, no la
      // realidad. Con esto se ve el `due_date` de verdad, quién ya pagó y —lo
      // que no se veía en ninguna pantalla— a quién no se le generó el cobro.
      const [periodYear, periodMonth] = todayColombia().split('-').map(Number);
      const { data: periodCharges } = await (supabase.from('payments') as any)
        .select('child_id, user_id, unregistered_athlete_id, team_id, status, due_date, amount, amount_paid, payment_category, concept, last_failure_at, last_failure_reason, requires_review')
        .eq('school_id', schoolId)
        .eq('period_year', periodYear)
        .eq('period_month', periodMonth)
        .neq('status', 'cancelled');

      // Deuda arrastrada: cobros sin pagar que vencieron ANTES de este mes. Sin
      // esto la pantalla solo hablaría del mes en curso y una mora vieja (Dynasty
      // tiene una del 2026-07-10) no se vería en ninguna parte de esta pestaña.
      const firstOfMonth = `${todayColombia().slice(0, 7)}-01`;
      const { data: oldDebt } = await (supabase.from('payments') as any)
        .select('child_id, user_id, unregistered_athlete_id, amount')
        .eq('school_id', schoolId)
        .in('status', ['pending', 'overdue'])
        .lt('due_date', firstOfMonth);

      const athleteKey = (r: { child_id?: string | null; user_id?: string | null; unregistered_athlete_id?: string | null }) =>
        r.child_id || r.user_id || r.unregistered_athlete_id || null;

      const arrearsByAthlete = new Map<string, { count: number; amount: number }>();
      for (const d of ((oldDebt as any[]) ?? [])) {
        const k = athleteKey(d);
        if (!k) continue;
        const acc = arrearsByAthlete.get(k) ?? { count: 0, amount: 0 };
        acc.count += 1;
        acc.amount += Number(d.amount) || 0;
        arrearsByAthlete.set(k, acc);
      }

      const chargesByAthlete = new Map<string, any[]>();
      for (const c of ((periodCharges as any[]) ?? [])) {
        const k = athleteKey(c);
        if (!k) continue;
        const list = chargesByAthlete.get(k);
        if (list) list.push(c); else chargesByAthlete.set(k, [c]);
      }

      /**
       * Cobro que representa a esta inscripción. Con multi-categoría un atleta
       * tiene dos inscripciones y puede tener dos cobros: se prefiere el del
       * mismo equipo antes de caer al primero que aparezca.
       */
      // La inscripción y el seguro del alta llevan el período del mes de entrada
      // (period_uniqueness_exempt): sin separarlos, uno de ellos podía quedar
      // como «el cobro de este mes» y la mensualidad y los otros no se veían.
      const chargeFor = (e: any): TeamSubscription['charge'] => {
        const k = athleteKey(e);
        const all = (k ? chargesByAthlete.get(k) ?? [] : []).filter(c => !isOneOffCharge(c));
        if (all.length === 0) return null;
        const sameTeam = e.team_id ? all.filter(c => c.team_id === e.team_id) : [];
        const pool = sameTeam.length > 0 ? sameTeam : all;
        const best = [...pool].sort((a, b) =>
          (CHARGE_PRIORITY[a.status] ?? 99) - (CHARGE_PRIORITY[b.status] ?? 99) ||
          (a.due_date ?? '9999-12-31').localeCompare(b.due_date ?? '9999-12-31'),
        )[0];
        return {
          status: best.status,
          due_date: best.due_date ?? null,
          amount: Number(best.amount) || 0,
          last_failure_at: best.last_failure_at ?? null,
          last_failure_reason: best.last_failure_reason ?? null,
          requires_review: best.requires_review === true,
        };
      };

      /** Inscripción / seguro / excedente del mes que siguen sin pagar. */
      const oneOffDueFor = (e: any): TeamSubscription['one_off_due'] => {
        const k = athleteKey(e);
        return (k ? chargesByAthlete.get(k) ?? [] : [])
          .filter(c => isOneOffCharge(c) && ['pending', 'overdue', 'partial'].includes(c.status))
          .map(c => ({
            label: chargeLabel(c),
            amount: c.status === 'partial'
              ? Math.max((Number(c.amount) || 0) - (Number(c.amount_paid) || 0), 0)
              : Number(c.amount) || 0,
          }));
      };

      const mapped: TeamSubscription[] = rawEnrollments.map(e => {
        let fullName = 'Sin nombre';
        if (e.child_id)                     fullName = childMap.get(e.child_id) || fullName;
        else if (e.user_id)                 fullName = profileMap.get(e.user_id) || fullName;
        else if (e.unregistered_athlete_id)   fullName = unregMap.get(e.unregistered_athlete_id) || fullName;

        const { fee, source } = effectiveFee(e);

        return {
          id: e.id,
          child_id: e.child_id,
          user_id: e.user_id,
          unregistered_athlete_id: e.unregistered_athlete_id,
          full_name: fullName,
          team_id: e.team_id,
          team_name: e.team?.name || null,
          branch_id: e.team?.branch_id ?? null,
          offering_plan_id: e.offering_plan_id,
          plan_name: e.plan?.name || null,
          fee,
          fee_source: source,
          plan_price_now: Number(e.plan?.price) || null,
          start_date: e.start_date,
          charge: chargeFor(e),
          one_off_due: oneOffDueFor(e),
          // La deuda vieja es del ATLETA, no de una inscripción suya. Si tiene
          // dos inscripciones activas (multi-categoría) el chip sale en ambas
          // filas, así que el TOTAL se suma una sola vez por `athlete_key`.
          athlete_key: athleteKey(e),
          arrears: (() => {
            const k = athleteKey(e);
            return k ? arrearsByAthlete.get(k) ?? null : null;
          })(),
        };
      });

      setTeamSubscriptions(mapped);
    } catch (error: unknown) {
      toast({ title: 'Error en suscripciones', description: getUserFriendlyError(error), variant: 'destructive' });
    }
  };

  // isAuthorized: profile.role handles regular users, currentUserRole handles school 'owner' role
  // (profile.role never contains 'owner' - that's a school_members role, not a profile role)
  const isAuthorized = profile && (
    ['school', 'admin', 'school_admin', 'super_admin', 'personal_trainer'].includes(profile.role) ||
    ['owner', 'admin', 'school_admin', 'super_admin', 'personal_trainer'].includes(currentUserRole || '')
  );
  if (!isAuthorized) return <Navigate to="/dashboard" replace />;

  // Rechazar = rechazar el COMPROBANTE con motivo (RejectReceiptDialog →
  // reject_payment_receipt). Antes `handleManualAction` ponía el propio cobro en
  // 'rejected' sin motivo y la deuda dejaba de figurar (bug 2026-10-08).

  const handleExportCSV = () => {
    if (payments.length === 0) { toast({ title: 'No hay datos', description: 'No hay transacciones para exportar.' }); return; }
    // Un campo con coma, comilla o salto de línea tiene que ir entrecomillado o
    // corre las columnas del resto de la fila. No es teórico: hay conceptos como
    // "Mensualidad 10/2026 - VIOLETA (pago adelantado del 31/07, ref TRF-...)",
    // y esas filas salían descuadradas del archivo.
    const csvCell = (v: unknown): string => {
      const s = v == null ? '' : String(v);
      return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const headers = ['Fecha de pago', 'Fecha de emisión', 'Acudiente', 'Deportista', 'Monto', 'Estado', 'Concepto', 'Tipo', 'Tipo de cobro'];
    const rows = payments.map(p => {
      const cfg = STATUS_CONFIG[p.status];
      return [
        // La fecha del movimiento es cuándo se pagó. Con `created_at` el reporte
        // fechaba los pagos el día en que se EMITIÓ el cobro (para una mensualidad
        // de agosto cobrada el 30 de julio, un mes antes del pago real).
        formatDayCO(p.payment_date || p.created_at),
        formatDayCO(p.created_at),
        // Los nombres ya resueltos: `parent`/`child` son null para atletas adultos
        // y sin cuenta, y el CSV los exportaba todos como "Desconocido" aunque la
        // tabla en pantalla sí mostrara el nombre.
        (p as any).parent_responsible || p.parent?.full_name || '—',
        (p as any).athlete_name || p.child?.full_name || 'Sin nombre',
        p.status === 'partial' ? (p.amount_paid ?? 0) : p.amount,
        cfg?.label ?? p.status,
        p.concept,
        p.payment_type || 'N/A',
        // Lo mismo que dice la insignia en pantalla («Clínica · <servicio>»).
        textoDeTipo(tipoDeCobro(p)) + (p.asiste_externo ? ' (externo)' : ''),
      ];
    });
    const csvContent = [headers, ...rows].map(e => e.map(csvCell).join(',')).join('\n');
    const blob = new Blob(['\ufeff' + csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `reporte_pagos_${todayColombia()}.csv`);
    document.body.appendChild(link); link.click(); document.body.removeChild(link);
    toast({ title: 'Reporte Generado', description: 'El archivo CSV se ha descargado correctamente.' });
  };

  /** «Cubre 3 cobros: Septiembre 2026, Octubre 2026 y Noviembre 2026 · $450.000», o null. */
  const proofGroupNote = (payment: PaymentTransaction): string | null => {
    const group = payment.receipt_url ? pendingReceiptGroups.get(payment.receipt_url) : undefined;
    if (!group) return null;
    const total = group.reduce((s, o) => s + remainingOf(o), 0);
    return `Cubre ${group.length} cobros: ${joinSpanish(orderReceiptGroup(group).map(o => (o as any).period_label || o.concept))} · ${formatCurrency(total)}`;
  };
  const handleShowProof = async (payment: PaymentTransaction) => {
    if (!payment.receipt_url) return;
    if (payment.receipt_url.startsWith('http')) {
      setViewingProof({ open: true, url: payment.receipt_url, student: payment.child?.full_name || 'Deportista', amount: payment.amount, group: proofGroupNote(payment) });
      return;
    }
    try {
      const cleanPath = normalizeReceiptUrl(payment.receipt_url);
      const { data, error } = await supabase.storage.from('payment-receipts').createSignedUrl(cleanPath, 300);
      if (error) throw error;
      setViewingProof({ open: true, url: data.signedUrl, student: payment.child?.full_name || 'Deportista', amount: payment.amount, group: proofGroupNote(payment) });
    } catch {
      toast({ title: 'Error de acceso', description: 'No se pudo generar el acceso al comprobante.', variant: 'destructive' });
    }
  };

  const formatDate = (dateStr: string) =>
    new Date(dateStr).toLocaleDateString('es-CO', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  /**
   * Formatea un 'YYYY-MM-DD' sin correrlo un día.
   *
   * `new Date('2026-08-03')` se parsea como medianoche UTC, que en Colombia es el 2 de
   * agosto a las 7 p.m. — o sea que una columna `date` se renderiza con el día anterior.
   * El sufijo 'T00:00:00' la fuerza a interpretarse en hora local.
   */
  const formatBusinessDate = (dateStr: string) =>
    new Date(dateStr + 'T00:00:00').toLocaleDateString('es-CO', { day: 'numeric', month: 'short', year: 'numeric' });

  /**
   * En "Cobros por Aprobar" la fecha que importa es CUÁNDO SE PAGÓ, no cuándo se emitió
   * el cobro. Antes se mostraba `created_at` y la escuela veía "30 de jul" en un pago
   * reportado el 3 de agosto: la fecha de emisión de la mensualidad, no la del pago.
   */
  const reportedDate = (p: PaymentTransaction) =>
    p.payment_date ? formatBusinessDate(p.payment_date) : formatDate(p.created_at);

  // "Validación de Cobros" muestra SOLO transferencias manuales que requieren
  // que la escuela apruebe/rechace el comprobante. Los pagos de MercadoPago
  // y Wompi NO aparecen aqui — los valida el gateway automaticamente y se
  // marcan paid via webhook. Si se mostraran aqui, la escuela podria aprobar
  // por error un pago que MP / Wompi todavia esta procesando.
  // ¿Lo gestiona una pasarela (lo confirma un webhook) o lo valida la escuela?
  // La regla vive en lib/paymentOrigin para que Finanzas y esta pantalla no se
  // contradigan. Antes se leía `payment_provider`, que no venía en el select →
  // undefined → la protección llevaba años muerta y los awaiting_approval de
  // pasarela sí caían en la cola de aprobación manual.
  const isGatewayManaged = isGatewayPayment;

  const rawPendingPayments = payments.filter(p => {
    const isGateway = isGatewayManaged(p);
    // "Por aprobar" = cobros con un PAGO REPORTADO que la escuela debe validar:
    //  - awaiting_approval: transferencia/comprobante reportado.
    //  - partial: abono en curso (completar saldo).
    //  - pending SOLO si trae comprobante (reportaron algo).
    // Las inscripciones por QR sin pagar (pending sin comprobante) NO entran
    // aquí — aprobarlas marcaría "pagado" sin que haya entrado plata. Quedan
    // como "Pendiente" en el historial y se saldan al registrar el pago.
    // Los de pasarela los confirma el webhook, no la escuela.
    return !isGateway && (
      p.status === 'awaiting_approval' ||
      p.status === 'partial' ||
      (p.status === 'pending' && !!p.receipt_url)
    );
  });
  // Orden de la cola: verde primero (se aprueba en un clic), luego amarillo,
  // sin veredicto y rojo; dentro de cada grupo, el que más lleva esperando.
  // Un comprobante que paga varios meses viene ligado a cada cobro (mismo
  // receipt_url): se muestran juntos y la hoja de aprobación los aprueba juntos.
  const pendingReceiptGroups = receiptGroups(rawPendingPayments);
  const receiptSiblings = (p: PaymentTransaction | null): PaymentTransaction[] =>
    p?.receipt_url ? (pendingReceiptGroups.get(p.receipt_url) ?? []).filter(o => o.id !== p.id) : [];
  const renderReceiptGroupChip = (p: PaymentTransaction) => {
    const group = p.receipt_url ? pendingReceiptGroups.get(p.receipt_url) : undefined;
    if (!group) return null;
    const total = group.reduce((s, o) => s + remainingOf(o), 0);
    return (
      <Badge variant="outline" title={group.map(o => (o as any).period_label || o.concept).join(' · ')} className="text-[10px] py-0 h-5 whitespace-nowrap bg-violet-50 text-violet-700 border-violet-200">
        1 comprobante · {group.length} cobros · {formatCurrency(total)}
      </Badge>
    );
  };
  const pendingSearched = rawPendingPayments.filter(p => {
    if (!pendingSearch) return true;
    const term = pendingSearch.toLowerCase();
    return p.child?.full_name?.toLowerCase().includes(term) ||
      p.parent?.full_name?.toLowerCase().includes(term) ||
      p.concept?.toLowerCase().includes(term) ||
      p.program?.name?.toLowerCase().includes(term) ||
      p.team?.name?.toLowerCase().includes(term);
  });
  // Conteo por tipo con la búsqueda aplicada y ANTES de filtrar por tipo, para
  // que elegir «Clínica» no esconda cuántas mensualidades quedan.
  const pendingTipoCounts = contarPorTipo(pendingSearched);
  const pendingPayments = keepReceiptGroupsTogether(sortReviewQueue(
    pendingTipoFilter === TODOS_LOS_TIPOS
      ? pendingSearched
      : pendingSearched.filter(p => tipoDeCobro(p).clave === pendingTipoFilter),
  ));
  // «Aprobar todos los verdes» trabaja sobre TODA la cola, no sobre la búsqueda.
  const greenSelection = bulkGreenSelection(rawPendingPayments);
  const WAIT_TONE_CLASS = {
    ok: 'bg-slate-50 text-slate-600 border-slate-200',
    warn: 'bg-amber-50 text-amber-700 border-amber-300',
    late: 'bg-red-50 text-red-700 border-red-300',
  } as const;
  const renderWaitingChip = (payment: PaymentTransaction) => {
    if (payment.status !== 'awaiting_approval') return null;
    const w = waitingLabel(waitingSince(payment), nowTick);
    return (
      <Badge variant="outline" title="Tiempo desde que entró el comprobante" className={`text-[10px] py-0 h-5 whitespace-nowrap ${WAIT_TONE_CLASS[w.tone]}`}>
        <Clock className="h-2.5 w-2.5 mr-1" /> Espera {w.label}
      </Badge>
    );
  };

  // Historial = plata que entró o un desenlace real, nada más:
  //  - paid / partial / rejected → movimiento con plata o con veredicto final
  //  - awaiting_approval DE PASARELA → transacción iniciada, solo lectura (la
  //    confirma el webhook; la escuela no la aprueba a mano)
  //  - el estado que se pida explícitamente en el selector (p.ej. Cancelado)
  // Un cobro emitido y no pagado (pending/overdue sin comprobante) YA NO entra:
  // no es una transacción y su lugar es la cartera de Finanzas. La regla vieja
  // era "todo lo que no está en la cola", y por eso el Historial mostraba 100
  // filas 'Pendiente' con Soporte N/A que nadie había pagado, mientras el KPI
  // "Transacciones" contaba solo paid|partial y nunca cuadraba con la tabla.
  const rawHistoryPayments = payments.filter(p => {
    if ((HISTORY_DEFAULT_STATUSES as readonly string[]).includes(p.status)) return true;
    if (p.status === 'awaiting_approval') return isGatewayManaged(p);
    return p.status === historyStatusFilter;
  });
  // Base = todo menos el filtro de estado. De acá salen los contadores de las
  // tarjetas, para que muestren cuánto hay en cada estado con la búsqueda y el
  // equipo ya aplicados (si contaran sobre el total, el número no cuadraría con
  // la tabla al buscar).
  /** Día en que entró la plata. Sin fecha de pago, lo único que hay es la emisión. */
  const paymentDay = (p: PaymentTransaction) => p.payment_date || dayInCO(p.created_at);

  /**
   * El Historial sí respeta el rango exacto elegido. La consulta al servidor deja
   * pasar de largo los estados de la cola (un comprobante por validar no se puede
   * esconder por antigüedad), así que el recorte fino va acá.
   */
  const inHistoryRange = (p: PaymentTransaction) => {
    const day = paymentDay(p);
    if (historyFrom && day < historyFrom) return false;
    if (historyTo && day > historyTo) return false;
    return true;
  };

  // Opciones del filtro de tipo: solo las que aparecen en el rango, contadas
  // antes de filtrar por tipo para que elegir una no esconda las demás.
  const historyInRange = rawHistoryPayments.filter(inHistoryRange);
  // Por tipo de cobro (lib/tipoDeCobro): separa la clínica de la clase extra y
  // la clase de prueba de la mensualidad, que con la categoría sola no se veía.
  const historyCategoryCounts = contarPorTipo(historyInRange);

  const historyBase = historyInRange.filter(p => {
    if (historyCategoryFilter !== TODOS_LOS_TIPOS && tipoDeCobro(p).clave !== historyCategoryFilter) return false;
    const searchMatch = !historySearch ||
      p.child?.full_name?.toLowerCase().includes(historySearch.toLowerCase()) ||
      p.parent?.full_name?.toLowerCase().includes(historySearch.toLowerCase()) ||
      p.concept?.toLowerCase().includes(historySearch.toLowerCase()) ||
      p.program?.name?.toLowerCase().includes(historySearch.toLowerCase()) ||
      p.team?.name?.toLowerCase().includes(historySearch.toLowerCase());
    const teamMatch = historyTeamFilter === 'all' || p.team?.name === historyTeamFilter || p.team_id === historyTeamFilter;
    return searchMatch && teamMatch;
  });
  // Orden por FECHA DEL PAGO, no por emisión. La consulta viene ordenada por
  // `created_at` (necesario para que el tope de 500 recorte lo más viejo), y con
  // ese orden un pago recibido hoy sobre una mensualidad emitida el 30/jul
  // aparecía sepultado entre las filas de julio en vez de arriba.
  // Dentro de cada día, los pagos de un mismo atleta van juntos (2026-11-07,
  // Dreamers: la mensualidad y las horas de una niña quedaban partidas).
  const historyPayments = ordenarPagosRecibidos(
    historyBase.filter(p => historyStatusFilter === 'all' || p.status === historyStatusFilter),
    paymentDay,
  );

  const historyCounts = historyBase.reduce<Record<string, number>>((acc, p) => {
    acc[p.status] = (acc[p.status] ?? 0) + 1;
    return acc;
  }, {});

  const historyTotalPages = Math.max(1, Math.ceil(historyPayments.length / HISTORY_ROWS_PER_VIEW));
  const pagedHistory = historyPayments.slice((historyPage - 1) * HISTORY_ROWS_PER_VIEW, historyPage * HISTORY_ROWS_PER_VIEW);
  // Filas seguidas del mismo atleta en el mismo día se dibujan como un bloque.
  const grupoHistorial = marcarGrupos(pagedHistory, p => `${paymentDay(p)}|${claveAtleta(p)}`);

  // Los agregados de dinero (ingresos históricos, saldo por validar, tasa de
  // aprobación) ya NO se calculan acá: se pedían sobre `payments`, que es la
  // página de 100 filas más recientes, y las tarjetas mostraban el total de esa
  // ventana como si fuera el histórico. Ahora vienen de school_payment_kpis.

  // ── Equipos y Planes ──────────────────────────────────────────────────────
  // La columna "Método" salió de acá: adivinaba el medio de pago buscando el
  // último pago dentro del array `payments`, que lo carga el Historial acotado
  // por estado, por el tope de 500 filas y por su rango de fechas. Si el pago
  // del atleta no caía en esa ventana, la fila decía "Pendiente" — o sea que
  // decía "Pendiente" en casi todas. El medio de pago se ve en el Historial,
  // donde el dato es real; acá lo que importa es el cobro del mes.

  /** Cómo va el cobro del mes de una inscripción. */
  const chargeState = (s: TeamSubscription): { label: string; className: string; detail: string | null } => {
    const hoy = todayColombia();
    const vence = s.charge?.due_date ?? null;
    const detail = vence ? `Vence ${formatDayCO(vence)}` : null;

    // Lo más importante de la pantalla: nadie le generó el cobro. Ni la cartera
    // de Finanzas lo muestra (no hay fila que mostrar) ni la cola de aprobación.
    if (!s.charge) {
      return { label: 'Sin cobro generado', className: 'bg-rose-100 text-rose-700 border-rose-200', detail: null };
    }

    // ERROR/VOIDED de la pasarela: `requires_review` es, desde ago 2026, lo
    // único que queda marcado — no sabemos si el dinero se movió y hay que
    // abrir el dashboard del proveedor. Pisa al estado del cobro porque es más
    // urgente que la fecha: cobrarle otra vez a alguien que ya pagó es peor
    // que cobrarle tarde. Distinto de «Por validar», que es un comprobante
    // esperando el ojo del admin, no una duda sobre si entró la plata.
    if (s.charge.requires_review) {
      return { label: 'Verificar en la pasarela', className: 'bg-orange-100 text-orange-800 border-orange-300', detail };
    }
    switch (s.charge.status) {
      case 'paid':
        return { label: 'Pagado', className: 'bg-green-500 text-white border-transparent', detail };
      case 'partial':
        return { label: 'Abono parcial', className: 'bg-blue-50 text-blue-700 border-blue-200', detail };
      case 'awaiting_approval':
        return { label: 'Por validar', className: 'bg-amber-100 text-amber-700 border-amber-200', detail };
      case 'glosado':
        return { label: 'En aclaración', className: 'bg-orange-100 text-orange-700 border-orange-200', detail };
      case 'rejected':
      case 'failed':
        return { label: 'Comprobante rechazado', className: 'bg-red-100 text-red-700 border-red-200', detail };
      default: {
        // pending / overdue: lo decide la fecha, no el estado. Un `pending` con
        // due_date de julio está vencido aunque nadie haya corrido el motor de mora.
        if (vence && vence < hoy) {
          const dias = daysDiffFromToday(vence);
          return {
            label: dias === 1 ? 'Vencido ayer' : `Vencido hace ${dias} días`,
            className: 'bg-red-50 text-red-600 border-red-200',
            detail,
          };
        }
        return { label: 'Al día', className: 'bg-slate-100 text-slate-700 border-slate-200', detail };
      }
    }
  };

  /** Prioridad de orden cuando se pide "Más urgente". */
  const urgencyRank = (s: TeamSubscription) => {
    if (!s.charge) return 0;                                   // nadie le generó el cobro
    if (s.arrears) return 1;                                   // arrastra deuda de otros meses
    if (s.charge.due_date && s.charge.due_date < todayColombia()
      && !['paid', 'partial'].includes(s.charge.status)) return 2;
    if (s.fee === 0) return 3;                                 // activo sin cuota
    if (s.charge.status === 'paid') return 6;
    return 4;
  };

  // C-12 F1 (docs/plan-tarifa-congelada-c12.md): cuántas inscripciones quedaron
  // en el precio que el plan tenía al inscribirse, y el catálogo subió después
  // sin que les cascadeara. Mismo alcance de sede que `subsFiltered`, pero sin
  // el filtro de texto — es un conteo, no debe moverse al buscar.
  const subsEnSede = teamSubscriptions
    .filter(s => inActiveBranch(s.branch_id));
  const subsConPlanPropio = subsEnSede.filter(s => s.fee_source === 'enrollment' && s.plan_price_now != null);
  const subsConTarifaCongelada = subsConPlanPropio.filter(s => s.plan_price_now !== s.fee);

  const subsFiltered = teamSubscriptions
    // Misma regla que la lista de cobros: sin sede solo en «Todas», salvo en
    // escuelas de una sola sede (ahí se veían caer 55 de Dynasty).
    .filter(s => inActiveBranch(s.branch_id))
    .filter(s => {
      const term = subsSearch.trim().toLowerCase();
      const searchMatch = !term ||
        s.full_name.toLowerCase().includes(term) ||
        (s.team_name || '').toLowerCase().includes(term) ||
        (s.plan_name || '').toLowerCase().includes(term);
      const teamMatch = subsTeamFilter === 'all' || s.team_name === subsTeamFilter || s.team_id === subsTeamFilter;
      return searchMatch && teamMatch;
    })
    .sort((a, b) => {
      if (subsSort === 'fee') return b.fee - a.fee || a.full_name.localeCompare(b.full_name);
      if (subsSort === 'urgency') return urgencyRank(a) - urgencyRank(b) || a.full_name.localeCompare(b.full_name);
      return a.full_name.localeCompare(b.full_name);
    });

  // Totales sobre lo filtrado, para que cuadren con lo que la tabla muestra.
  // La deuda anterior se suma una vez por atleta: es suya, no de cada inscripción.
  const subsTotals = (() => {
    const seenDebt = new Set<string>();
    return subsFiltered.reduce(
      (acc, s) => {
        acc.expected += s.fee;
        if (s.charge) acc.billed += s.charge.amount;
        else { acc.unbilled += s.fee; acc.unbilledCount += 1; }
        if (s.fee === 0) acc.noFee += 1;
        if (s.arrears && s.athlete_key && !seenDebt.has(s.athlete_key)) {
          seenDebt.add(s.athlete_key);
          acc.arrears += s.arrears.amount;
          acc.arrearsCount += 1;
        }
        return acc;
      },
      { expected: 0, billed: 0, unbilled: 0, unbilledCount: 0, noFee: 0, arrears: 0, arrearsCount: 0 },
    );
  })();

  const subsTotalPages = Math.max(1, Math.ceil(subsFiltered.length / SUBS_PAGE_SIZE));
  const pagedSubs = subsFiltered.slice((subsPage - 1) * SUBS_PAGE_SIZE, subsPage * SUBS_PAGE_SIZE);

  return (
    <div className="space-y-6 w-full max-w-full overflow-x-hidden animate-in fade-in">

      {/* ── Header ────────────────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Gestión de Pagos</h1>
          <p className="text-muted-foreground text-sm">
            Administra cobros, validaciones y el historial financiero{activeBranchId ? ' de la sede actual.' : '.'}
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          {showRegisterButton && (
          <Button 
            onClick={() => setShowCashModal(true)}
            variant="outline"
            size="sm"
            className="gap-2 text-emerald-600 border-emerald-200 hover:bg-emerald-50"
            data-testid="open-register-payment"
          >
            <Banknote className="h-4 w-4" />
            <span className="hidden sm:inline">{cobrosYPagosOn ? 'Cobros y pagos' : 'Registrar pago'}</span>
            <span className="sm:hidden">{cobrosYPagosOn ? 'Cobros' : 'Pago'}</span>
          </Button>
          )}
          {canManageCharges(currentUserRole) && (
          <Button
            onClick={() => setShowClasesPrueba(true)}
            variant="outline"
            size="sm"
            className="gap-2"
            data-testid="open-clases-prueba"
          >
            <UserPlus className="h-4 w-4" />
            <span className="hidden sm:inline">Clases de prueba</span>
            <span className="sm:hidden">Prueba</span>
          </Button>
          )}
          <Button variant="outline" size="sm" onClick={fetchPayments} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Clock className="h-4 w-4 mr-2" />}
            <span className="hidden sm:inline">Actualizar</span>
          </Button>
          <Button variant="default" size="sm" onClick={handleExportCSV}>
            <Download className="h-4 w-4 mr-2" />
            <span className="hidden sm:inline">Exportar Reporte</span>
            <span className="sm:hidden">Exportar</span>
          </Button>
        </div>
      </div>

      {/* ── Stats: 2 cols en mobile, 4 en lg ─────────────────────────────── */}
      <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
        {[
          // Las 4 tarjetas salen del RPC (histórico completo), no del array de
          // 100 filas: así calculadas mostraban $150.000 de $1.250.000 reales.
          // Sin datos del RPC se muestra '—', nunca un número inventado.
          // "todos los meses" explícito: este número es global y no cuadra con
          // "Ingresos del Mes" del panel, que es solo el mes en curso.
          { title: 'Ingresos Totales', value: kpis ? formatCurrency(kpis.revenue_total) : '—', sub: 'Histórico acumulado · todos los meses', icon: TrendingUp, color: 'text-emerald-500' },
          { title: 'Por Validar', value: kpis ? kpis.awaiting_count : '—', sub: kpis ? `${formatCurrency(kpis.awaiting_amount)} pendientes` : 'Sin datos', icon: Clock, color: 'text-amber-500' },
          // Transacciones = pagos con plata movida (paid|partial). Un cobro
          // emitido y no pagado NO es una transacción; contarlos daba 100.
          { title: 'Transacciones', value: kpis ? kpis.tx_count : '—', sub: kpis ? `${kpis.charges_total} cobros emitidos` : 'Sin datos', icon: CreditCard, color: 'text-blue-500' },
          // Tasa sobre INTENTOS de pago, no sobre cobros emitidos (daba 1%).
          { title: 'Tasa Aprobación', value: kpis?.approval_rate != null ? `${kpis.approval_rate}%` : '—', sub: kpis ? `${kpis.attempts} intento(s) de pago` : 'Sin datos', icon: CheckCircle2, color: 'text-primary' },
        ].map(({ title, value, sub, icon: Icon, color }) => (
          <Card key={title}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2 p-3 sm:p-6">
              <CardTitle className="text-xs sm:text-sm font-medium line-clamp-1">{title}</CardTitle>
              <Icon className={`h-4 w-4 shrink-0 ${color}`} />
            </CardHeader>
            <CardContent className="p-3 pt-0 sm:p-6 sm:pt-0">
              <div className="text-lg sm:text-2xl font-bold truncate">{value}</div>
              <p className="text-xs text-muted-foreground line-clamp-1">{sub}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* ── Tabs: scroll horizontal en mobile ────────────────────────────── */}
      <Tabs
        value={activeTab}
        onValueChange={(v) => setSearchParams(prev => {
          const next = new URLSearchParams(prev);
          next.set('tab', v);
          return next;
        }, { replace: true })}
        className="space-y-4"
      >
        <div className="overflow-x-auto pb-1">
          <TabsList className="w-max min-w-full sm:w-auto">
            <TabsTrigger value="recurrent" className="text-xs sm:text-sm">Cobros</TabsTrigger>
            <TabsTrigger value="teams" className="text-xs sm:text-sm">Equipos y Planes</TabsTrigger>
            <TabsTrigger value="glosas" className="text-xs sm:text-sm">Glosas</TabsTrigger>
            <TabsTrigger value="conciliacion" className="text-xs sm:text-sm">Conciliación</TabsTrigger>
            {/* Antes decía «Historial» — chocaba con DOS pestañas de Finanzas:
                "Historial de pagos" (grilla por atleta mes a mes) y la suya
                propia "Transacciones" (TransactionsCard, más liviana). Esta es
                la vista completa de lo que entró (con filtros, soporte y
                origen) — "Pagos recibidos" no choca con ninguna de las dos. */}
            <TabsTrigger value="history" className="text-xs sm:text-sm">Pagos recibidos</TabsTrigger>
            <TabsTrigger value="cierre" className="text-xs sm:text-sm">Cierre</TabsTrigger>
            <TabsTrigger value="debito" className="text-xs sm:text-sm">Débito automático</TabsTrigger>
            <TabsTrigger value="config" className="text-xs sm:text-sm">Config</TabsTrigger>
            {showOperacionesTab && <TabsTrigger value="operaciones" className="text-xs sm:text-sm">Operaciones</TabsTrigger>}
          </TabsList>
        </div>

        {/* ── Tab: Validación de cobros ────────────────────────────────── */}
        <TabsContent value="recurrent">
          <Card className="border-amber-200 bg-amber-50/10">
            <CardHeader className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
              <div>
                <CardTitle className="flex items-center gap-2 text-base sm:text-lg">
                  <Clock className="h-5 w-5 text-amber-600 shrink-0" />
                  Cobros por Aprobar
                </CardTitle>
                <CardDescription>Confirma los cobros con pago reportado (comprobantes y abonos). Los cobros emitidos que nadie ha pagado están en la cartera, en Finanzas. Primero los verdes, y dentro de cada color el que más lleva esperando.</CardDescription>
              </div>
              <div className="w-full sm:w-auto flex flex-col sm:flex-row gap-2">
                {greenSelection.eligible.length > 0 && (
                  <Button
                    size="sm"
                    className="h-9 bg-emerald-600 hover:bg-emerald-700 whitespace-nowrap"
                    onClick={() => setBulkGreensOpen(true)}
                  >
                    <CheckCircle2 className="h-4 w-4 mr-1" />
                    Aprobar todos los verdes ({greenSelection.eligible.length})
                  </Button>
                )}
                <Input
                  placeholder="Buscar alumno, padre o equipo..."
                  value={pendingSearch}
                  onChange={(e) => setPendingSearch(e.target.value)}
                  className="w-full sm:w-64 h-9"
                />
              </div>
            </CardHeader>
            <CardContent className="p-0 sm:p-6">
              {/* Qué es cada cobro (blindaje ventas de servicio §4.D): la clínica,
                  el torneo o la clase de prueba no se confunden con la mensualidad. */}
              {!loading && rawPendingPayments.length > 0 && (
                <FiltroTipoDeCobro
                  className="px-4 pt-4 sm:px-0 sm:pt-0 pb-3"
                  conteos={pendingTipoCounts}
                  valor={pendingTipoFilter}
                  onChange={setPendingTipoFilter}
                />
              )}
              {loading ? (
                <div className="flex justify-center py-8"><Loader2 className="animate-spin h-8 w-8 text-muted-foreground" /></div>
              ) : pendingPayments.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground flex flex-col items-center p-6">
                  <CheckCircle2 className="h-12 w-12 text-muted-foreground/50 mb-4" />
                  <p>{rawPendingPayments.length > 0 ? 'No hay cobros por validar con este filtro.' : 'No hay pagos pendientes por validar.'}</p>
                </div>
              ) : (
                <>
                  {/* Mobile cards */}
                  <div className="grid grid-cols-1 gap-3 p-4 md:hidden">
                    {pendingPayments.map((payment) => (
                      <div key={payment.id} className="border rounded-lg p-4 space-y-3 bg-card">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5 min-w-0">
                              <p className="font-bold text-sm truncate">{payment.athlete_name || 'Sin nombre'}</p>
                              {payment.asiste_externo && <ExternoBadge />}
                            </div>
                            <div className="flex gap-1 flex-wrap mt-0.5">
                              <TipoDeCobroBadge payment={payment} className="max-w-full" />
                              {payment.team?.name && (
                                <Badge variant="outline" className="text-[10px] bg-red-50 text-red-700 border-red-200 py-0 h-4">
                                  <Trophy className="h-2.5 w-2.5 mr-1" /> {payment.team.name}
                                </Badge>
                              )}
                              {(payment as any).plan?.name && (
                                <Badge variant="outline" className="text-[10px] bg-purple-50 text-purple-700 border-purple-200 py-0 h-4">
                                  <Zap className="h-2.5 w-2.5 mr-1" /> {(payment as any).plan.name}
                                </Badge>
                              )}
                              {(payment as any).period_label && (
                                <Badge variant="outline" className="text-[10px] bg-blue-50 text-blue-700 border-blue-200 py-0 h-4">
                                  {(payment as any).period_label}
                                </Badge>
                              )}
                              {showBranchCol && <BranchChip branchId={payment.branch_id} branches={branches} className="h-4" />}
                              {!payment.team?.name && !(payment as any).plan?.name && (
                                <span className="text-xs text-muted-foreground truncate">{payment.concept}</span>
                              )}
                            </div>
                            {(payment as any).period_already_settled && (
                              <div className="mt-1 flex items-center gap-1 text-[10px] font-bold text-red-600">
                                <AlertTriangle className="h-3 w-3" /> Este mes ya fue pagado y aprobado
                              </div>
                            )}
                            <p className="text-xs text-muted-foreground">{(payment as any).parent_responsible || '—'}</p>
                            <FamilyNote note={familyNotes[payment.id]} />
                          </div>
                          <div className="text-right shrink-0">
                            <p className="font-bold text-primary text-sm">{formatCurrency(payment.amount)}</p>
                            <p className="text-xs text-muted-foreground">{reportedDate(payment)}</p>
                            <div className="mt-1 flex flex-wrap gap-1 justify-end">
                              {renderWaitingChip(payment)}
                              {(payment.receipt_url || payment.status === 'awaiting_approval') ? (
                                <Badge variant="outline" className="text-[10px] bg-blue-50 text-blue-700 border-blue-200">Transferencia</Badge>
                              ) : (
                                <Badge variant="outline" className="text-[10px] bg-emerald-50 text-emerald-700 border-emerald-200">Inscripción QR</Badge>
                              )}
                              <DestinoBadge payment={payment} />
                              <VerdictBadge verdict={payment.receipt_verdict} reasons={payment.receipt_verdict_reasons} />
                              {renderReceiptGroupChip(payment)}
                            </div>
                          </div>
                        </div>
                        <div className="flex gap-2 flex-wrap">
                          {payment.receipt_url && (
                            <Button variant="outline" size="sm" className="h-8 gap-1 text-blue-600 border-blue-200 bg-blue-50" onClick={() => handleShowProof(payment)}>
                              <Eye className="h-3 w-3" /> Comprobante
                            </Button>
                          )}
                          <Button size="sm" variant="outline" className="h-8 text-green-600 border-green-200 hover:bg-green-50" onClick={() => setPaymentToApprove(payment)}>
                            <CheckCircle2 className="h-3 w-3 mr-1" />
                            Aprobar
                          </Button>
                          <Button size="sm" variant="outline" className="h-8 text-red-600 border-red-200 hover:bg-red-50" disabled={!(payment.status === 'awaiting_approval' || ((payment.status === 'pending' || payment.status === 'overdue') && !!payment.receipt_url))} onClick={() => setRejectingPayment(payment)}>
                            <XCircle className="h-3 w-3 mr-1" />
                            Rechazar
                          </Button>
                          <Button size="sm" variant="outline" className="h-8 text-orange-600 border-orange-200 hover:bg-orange-50" onClick={() => setCreatingGlosaPayment(payment)}>
                            <AlertTriangle className="h-3 w-3 mr-1" />
                            Glosar
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                  {/* Desktop table */}
                  <div className="hidden md:block overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Fecha</TableHead>
                          <TableHead>Deportista / Programa</TableHead>
                          {showBranchCol && <TableHead>Sede</TableHead>}
                          <TableHead>Padre</TableHead>
                          <TableHead>Monto</TableHead>
                          <TableHead>Origen</TableHead>
                          <TableHead>Comprobante</TableHead>
                          <TableHead className="text-right">Acciones</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {pendingPayments.map((payment) => (
                          <TableRow key={payment.id}>
                            <TableCell className="font-mono text-xs align-top">
                              <div className="flex flex-col gap-1 items-start">
                                <span>{reportedDate(payment)}</span>
                                {renderWaitingChip(payment)}
                              </div>
                            </TableCell>
                            <TableCell>
                              <div className="flex flex-col">
                                <span className="flex items-center gap-1.5">
                                  <span className="font-bold">{payment.athlete_name || 'Sin nombre'}</span>
                                  {payment.asiste_externo && <ExternoBadge />}
                                </span>
                                <div className="flex gap-1 flex-wrap mt-0.5">
                                  <TipoDeCobroBadge payment={payment} />
                                  {payment.team?.name && (
                                    <Badge variant="outline" className="text-[10px] bg-red-50 text-red-700 border-red-200 py-0 h-5">
                                      <Trophy className="h-2.5 w-2.5 mr-1" /> {payment.team.name}
                                    </Badge>
                                  )}
                                  {(payment as any).plan?.name && (
                                    <Badge variant="outline" className="text-[10px] bg-purple-50 text-purple-700 border-purple-200 py-0 h-5">
                                      <Zap className="h-2.5 w-2.5 mr-1" /> {(payment as any).plan.name}
                                    </Badge>
                                  )}
                                  {(payment as any).period_label && (
                                    <Badge variant="outline" className="text-[10px] bg-blue-50 text-blue-700 border-blue-200 py-0 h-5">
                                      {(payment as any).period_label}
                                    </Badge>
                                  )}
                                  {!payment.team?.name && !(payment as any).plan?.name && (
                                    <span className="text-xs text-muted-foreground">{payment.concept}</span>
                                  )}
                                </div>
                                {(payment as any).period_already_settled && (
                                  <div className="mt-1 flex items-center gap-1 text-[10px] font-bold text-red-600">
                                    <AlertTriangle className="h-3 w-3" /> Este mes ya fue pagado y aprobado
                                  </div>
                                )}
                                <FamilyNote note={familyNotes[payment.id]} />
                              </div>
                            </TableCell>
                            {showBranchCol && (
                              <TableCell className="align-top"><BranchChip branchId={payment.branch_id} branches={branches} /></TableCell>
                            )}
                            <TableCell><span className="text-sm">{(payment as any).parent_responsible || <span className="text-muted-foreground text-xs">—</span>}</span></TableCell>
                            <TableCell className="font-bold text-primary whitespace-nowrap align-top">
                              <div className="flex flex-col gap-0.5">
                                <span>{formatCurrency(payment.amount)}</span>
                                {(payment.status === 'partial' || (Number(payment.amount_paid) || 0) > 0) && (
                                  <>
                                    <Badge variant="outline" className="w-fit whitespace-nowrap text-[10px] bg-indigo-50 text-indigo-700 border-indigo-200 py-0 h-4 px-1.5 font-semibold">
                                      Abono parcial
                                    </Badge>
                                    <span className="text-[10px] font-normal text-muted-foreground whitespace-nowrap">
                                      Abonado {formatCurrency(Number(payment.amount_paid) || 0)} · saldo {formatCurrency(remainingOf(payment))}
                                    </span>
                                  </>
                                )}
                              </div>
                            </TableCell>
                            <TableCell>
                              {(payment.receipt_url || payment.status === 'awaiting_approval') ? (
                                <Badge variant="outline" className="text-[10px] bg-blue-50 text-blue-700 border-blue-200">Transferencia</Badge>
                              ) : (
                                <Badge variant="outline" className="text-[10px] bg-emerald-50 text-emerald-700 border-emerald-200">Inscripción QR</Badge>
                              )}
                            </TableCell>
                            <TableCell>
                              {payment.receipt_url ? (
                                <div className="flex flex-col gap-1 items-start">
                                  <Button variant="outline" size="sm" className="h-8 gap-1 text-blue-600 border-blue-200 bg-blue-50" onClick={() => handleShowProof(payment)}>
                                    <Eye className="h-3 w-3" /> Ver
                                  </Button>
                                  <DestinoBadge payment={payment} />
                              <VerdictBadge verdict={payment.receipt_verdict} reasons={payment.receipt_verdict_reasons} />
                                  {renderReceiptGroupChip(payment)}
                                </div>
                              ) : (
                                <span className="text-xs text-muted-foreground">—</span>
                              )}
                            </TableCell>
                            <TableCell className="text-right">
                              <div className="flex justify-end gap-2">
                                <Button size="sm" variant="outline" className="text-green-600 border-green-200 hover:bg-green-50" onClick={() => setPaymentToApprove(payment)}>
                                  <CheckCircle2 className="h-3 w-3 mr-1" />
                                  Aprobar
                                </Button>
                                <Button size="sm" variant="outline" className="text-red-600 border-red-200 hover:bg-red-50" disabled={!(payment.status === 'awaiting_approval' || ((payment.status === 'pending' || payment.status === 'overdue') && !!payment.receipt_url))} onClick={() => setRejectingPayment(payment)}>
                                  <XCircle className="h-3 w-3 mr-1" /> Rechazar
                                </Button>
                                <Button size="sm" variant="outline" className="text-orange-600 border-orange-200 hover:bg-orange-50" onClick={() => setCreatingGlosaPayment(payment)}>
                                  <AlertTriangle className="h-3 w-3 mr-1" /> Glosar
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </>
              )}
              <TableRefreshBar
                className="-mx-0 sm:-mx-6 sm:-mb-6 mt-2 sm:rounded-b-lg"
                onRefresh={fetchPayments}
                loading={loading}
                summary={`${pendingPayments.length} cobro(s) por aprobar`}
              />
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Tab: Equipos y Planes ────────────────────────────────────── */}
        <TabsContent value="teams">
          <Card>
            <CardHeader className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
              <div>
                <CardTitle className="text-base sm:text-lg">Vista por Equipos y Planes</CardTitle>
                <CardDescription>
                  Una fila por inscripción activa: cuánto se le cobra y cómo va su cobro de este mes.
                </CardDescription>
                {subsConTarifaCongelada.length > 0 && (
                  <p className="text-xs text-amber-600 mt-1">
                    {subsConTarifaCongelada.length} de {subsConPlanPropio.length} inscripciones están en una tarifa
                    anterior a la del plan — el precio se les copió al entrar y el plan subió después.
                  </p>
                )}
              </div>
              <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto">
                <Input
                  placeholder="Buscar alumno, equipo o plan..."
                  value={subsSearch}
                  onChange={(e) => setSubsSearch(e.target.value)}
                  className="w-full sm:w-60 h-9"
                />
                <select
                  className="flex h-9 w-full sm:w-40 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  value={subsTeamFilter}
                  onChange={(e) => setSubsTeamFilter(e.target.value)}
                >
                  <option value="all">Todos los Equipos</option>
                  {activeTeams.map(team => (
                    <option key={team.id} value={team.name}>{team.name}</option>
                  ))}
                </select>
                <select
                  className="flex h-9 w-full sm:w-40 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  value={subsSort}
                  onChange={(e) => setSubsSort(e.target.value as 'name' | 'fee' | 'urgency')}
                >
                  <option value="name">Nombre (A-Z)</option>
                  <option value="urgency">Más urgente</option>
                  <option value="fee">Mayor cuota</option>
                </select>
              </div>
            </CardHeader>
            <CardContent className="p-0 sm:p-6">
              {/* Totales de lo que la tabla está mostrando. Antes no había ninguno:
                  la pantalla de los cobros programados no decía cuánto se espera cobrar. */}
              <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 px-4 sm:px-0 pt-4 sm:pt-0 pb-4">
                <div className="rounded-lg border p-3">
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Esperado mensual</p>
                  <p className="text-lg font-bold">{formatCurrency(subsTotals.expected)}</p>
                  <p className="text-[11px] text-muted-foreground">{subsFiltered.length} inscripciones activas</p>
                </div>
                <div className="rounded-lg border p-3">
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Facturado este mes</p>
                  <p className="text-lg font-bold text-emerald-600">{formatCurrency(subsTotals.billed)}</p>
                  <p className="text-[11px] text-muted-foreground">cobros ya emitidos</p>
                </div>
                <div className="rounded-lg border p-3">
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Sin facturar</p>
                  <p className={`text-lg font-bold ${subsTotals.unbilled > 0 ? 'text-rose-600' : ''}`}>
                    {formatCurrency(subsTotals.unbilled)}
                  </p>
                  <p className="text-[11px] text-muted-foreground">{subsTotals.unbilledCount} sin cobro generado</p>
                </div>
                {/* Deuda de meses anteriores. Es del atleta, así que se cuenta
                    una vez por persona aunque tenga dos inscripciones. */}
                <div className="rounded-lg border p-3">
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Deuda anterior</p>
                  <p className={`text-lg font-bold ${subsTotals.arrears > 0 ? 'text-red-600' : ''}`}>
                    {formatCurrency(subsTotals.arrears)}
                  </p>
                  <p className="text-[11px] text-muted-foreground">{subsTotals.arrearsCount} atletas con mora</p>
                </div>
                <div className="rounded-lg border p-3">
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Sin cuota</p>
                  <p className={`text-lg font-bold ${subsTotals.noFee > 0 ? 'text-amber-600' : ''}`}>{subsTotals.noFee}</p>
                  <p className="text-[11px] text-muted-foreground">activos en cero</p>
                </div>
              </div>

              {/* Mobile cards */}
              <div className="grid grid-cols-1 gap-3 p-4 md:hidden">
                {loading ? (
                  <div className="flex justify-center py-8"><Loader2 className="animate-spin h-6 w-6 text-muted-foreground" /></div>
                ) : pagedSubs.length === 0 ? (
                  <p className="text-center text-muted-foreground py-8">No hay inscripciones activas con estos filtros.</p>
                ) : pagedSubs.map((sub) => {
                  const st = chargeState(sub);
                  return (
                    <div key={sub.id} className="border rounded-lg p-4 space-y-2">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="font-medium text-sm truncate">{sub.full_name}</p>
                          <p className="text-xs text-muted-foreground truncate">
                            {[sub.team_name, sub.plan_name].filter(Boolean).join(' · ') || 'Sin equipo ni plan'}
                          </p>
                        </div>
                        <div className="text-right shrink-0">
                          <p className="font-bold text-sm">{formatCurrency(sub.fee)}</p>
                          {sub.fee === 0 && <p className="text-[10px] text-amber-600">sin cuota</p>}
                        </div>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <Badge variant="outline" className={`text-[10px] ${st.className}`}>{st.label}</Badge>
                        {st.detail && <span className="text-[11px] text-muted-foreground">{st.detail}</span>}
                      </div>
                      <FailedAttemptChip
                        reason={sub.charge?.last_failure_reason}
                        at={sub.charge?.last_failure_at}
                      />
                      {sub.one_off_due.map((o, idx) => (
                        <p key={idx} className="text-[11px] font-medium text-red-600">
                          + {o.label} {formatCurrency(o.amount)} sin pagar
                        </p>
                      ))}
                      {sub.arrears && (
                        <p className="text-[11px] font-medium text-red-600">
                          Debe {formatCurrency(sub.arrears.amount)} de meses anteriores
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Desktop table */}
              <div className="hidden md:block overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Alumno</TableHead>
                      <TableHead>Equipo</TableHead>
                      <TableHead>Plan</TableHead>
                      <TableHead>Mensualidad</TableHead>
                      <TableHead>Cobro de este mes</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {loading ? (
                      <TableRow><TableCell colSpan={5} className="text-center py-8"><Loader2 className="animate-spin h-5 w-5 mx-auto text-muted-foreground" /></TableCell></TableRow>
                    ) : pagedSubs.length === 0 ? (
                      <TableRow><TableCell colSpan={5} className="text-center py-8 text-muted-foreground">No hay inscripciones activas con estos filtros.</TableCell></TableRow>
                    ) : pagedSubs.map((sub) => {
                      const st = chargeState(sub);
                      return (
                        <TableRow key={sub.id}>
                          <TableCell className="font-medium">{sub.full_name}</TableCell>
                          <TableCell>
                            {sub.team_name ? (
                              <Badge variant="outline" className="text-[10px] bg-blue-50 text-blue-700 border-blue-100">
                                <Trophy className="h-3 w-3 mr-1" />{sub.team_name}
                              </Badge>
                            ) : <span className="text-xs text-muted-foreground">—</span>}
                          </TableCell>
                          <TableCell>
                            {sub.plan_name ? (
                              <Badge variant="outline" className="text-[10px] bg-purple-50 text-purple-700 border-purple-200">
                                <Zap className="h-3 w-3 mr-1" />{sub.plan_name}
                              </Badge>
                            ) : <span className="text-xs text-muted-foreground">—</span>}
                          </TableCell>
                          {/* El monto que se cobra de verdad, con su origen a la vista: un
                              cero acá es una inscripción activa sin cuota, no un error de lectura. */}
                          <TableCell>
                            <span className="font-bold">{formatCurrency(sub.fee)}</span>
                            {sub.fee === 0 ? (
                              <span className="block text-[10px] text-amber-600">sin cuota asignada</span>
                            ) : sub.fee_source !== 'enrollment' ? (
                              <span className="block text-[10px] text-muted-foreground">
                                heredada {sub.fee_source === 'plan' ? 'del plan' : 'del equipo'}
                              </span>
                            ) : sub.plan_price_now != null && sub.plan_price_now !== sub.fee && (
                              // Tarifa congelada (C-12 F1): el plan cambió de precio después de
                              // que esta inscripción copió el suyo al entrar. No es un error —
                              // puede ser una decisión legítima de la escuela— pero hoy era
                              // información que nadie tenía.
                              <span className="block text-[10px] text-amber-600">
                                el plan hoy vale {formatCurrency(sub.plan_price_now)}
                              </span>
                            )}
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline" className={`text-xs ${st.className}`}>{st.label}</Badge>
                            {st.detail && <span className="block text-[11px] text-muted-foreground mt-0.5">{st.detail}</span>}
                            {sub.charge?.last_failure_reason && (
                              <span className="block mt-1">
                                <FailedAttemptChip
                                  reason={sub.charge.last_failure_reason}
                                  at={sub.charge.last_failure_at}
                                />
                              </span>
                            )}
                            {sub.one_off_due.map((o, idx) => (
                              <span key={idx} className="block text-[11px] font-medium text-red-600 mt-0.5">
                                + {o.label} {formatCurrency(o.amount)} sin pagar
                              </span>
                            ))}
                            {sub.arrears && (
                              <span className="block text-[11px] font-medium text-red-600 mt-0.5">
                                Debe {formatCurrency(sub.arrears.amount)} de {sub.arrears.count} cobro
                                {sub.arrears.count === 1 ? '' : 's'} anterior{sub.arrears.count === 1 ? '' : 'es'}
                              </span>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
              <TableRefreshBar
                className="-mx-0 sm:-mx-6 sm:-mb-6 mt-2 sm:rounded-b-lg"
                onRefresh={loadTeamSubscriptions}
                loading={loading}
                summary={
                  subsTotalPages > 1
                    ? `Página ${subsPage} de ${subsTotalPages} · ${subsFiltered.length} inscripciones`
                    : `${subsFiltered.length} inscripciones`
                }
              >
                {subsTotalPages > 1 && (
                  <>
                    <Button variant="outline" size="sm" disabled={subsPage <= 1}
                      onClick={() => setSubsPage((p) => Math.max(1, p - 1))}>Anterior</Button>
                    <Button variant="outline" size="sm" disabled={subsPage >= subsTotalPages}
                      onClick={() => setSubsPage((p) => Math.min(subsTotalPages, p + 1))}>Siguiente</Button>
                  </>
                )}
              </TableRefreshBar>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Tab: Glosas (aclaraciones) ───────────────────────────────── */}
        <TabsContent value="glosas">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <AlertTriangle className="h-4 w-4 text-orange-500" /> Aclaraciones (glosas)
              </CardTitle>
              <CardDescription>
                Comprobantes que necesitan una aclaración del acudiente. Concilia en vez de rechazar.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {(() => {
                const today = todayColombia();
                const open = glosas.filter(g => OPEN_GLOSA_STATUSES.includes(g.status));
                const overdue = open.filter(g => g.responds_by < today).length;
                const dueSoon = open.filter(g => g.responds_by >= today && g.responds_by <= today).length;
                return (
                  <div className="flex flex-wrap gap-2">
                    <Badge variant="outline" className="bg-blue-50 text-blue-700 border-blue-200">Abiertas: {open.length}</Badge>
                    <Badge variant="outline" className="bg-red-50 text-red-700 border-red-200">Vencidas: {overdue}</Badge>
                    <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200">Vencen hoy: {dueSoon}</Badge>
                  </div>
                );
              })()}

              {glosas.length === 0 ? (
                <div className="py-10 text-center text-sm text-muted-foreground">
                  No hay aclaraciones. Abre una desde un comprobante con el botón "Glosar".
                </div>
              ) : (
                <div className="space-y-2">
                  {(() => {
                    // El join del BFF no trae la categoría ni el prospecto: se
                    // toman del cobro ya cargado en la pantalla cuando está.
                    const pagosPorId = new Map(payments.map(p => [p.id, p]));
                    return juntarPorAtleta(glosas, g => g.payments?.child?.full_name || g.payments?.parent?.full_name).map(g => {
                      const pago = pagosPorId.get(g.payment_id);
                      const cobro = { payment_category: pago?.payment_category ?? null, concept: g.payments?.concept ?? pago?.concept ?? null };
                      return (
                    <div key={g.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-semibold text-sm truncate">
                            {g.payments?.parent?.full_name || g.payments?.child?.full_name || pago?.athlete_name || nombreDeQuienAsiste({ concept: cobro.concept }).nombre || 'Acudiente'}
                          </span>
                          {pago?.asiste_externo && <ExternoBadge />}
                          <TipoDeCobroBadge payment={cobro} />
                          <Badge variant="outline" className="text-[10px]">{REASON_ADMIN_LABELS[g.reason]}</Badge>
                          <Badge variant="outline" className="text-[10px] bg-muted">{STATUS_LABELS[g.status]}</Badge>
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {g.payments?.concept || 'Cobro'} · {formatCurrency(g.payments?.amount || 0)} · responde antes del {g.responds_by}
                        </p>
                      </div>
                      <Button size="sm" variant="outline" className="h-8" onClick={() => setConciliatingGlosa(g)}>
                        {OPEN_GLOSA_STATUSES.includes(g.status) ? 'Conciliar' : 'Ver'}
                      </Button>
                    </div>
                      );
                    });
                  })()}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Tab: Conciliación bancaria (Fase 6) ──────────────────────── */}
        <TabsContent value="conciliacion">
          {schoolId ? (
            <ReconciliationTab schoolId={schoolId} />
          ) : (
            <p className="text-sm text-muted-foreground">Selecciona una escuela para conciliar.</p>
          )}
        </TabsContent>

        {/* ── Tab: Pagos recibidos ─────────────────────────────────────── */}
        <TabsContent value="history">
          <Card>
            <CardHeader className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
              <div>
                <CardTitle className="text-base sm:text-lg">Pagos recibidos</CardTitle>
                <CardDescription>
                  Pagos que entraron: comprobante aprobado (manual o automático), efectivo, QR y pasarela —
                  de cualquier origen, incluido lo que la familia paga directo. Los cobros por cobrar no son
                  transacciones — están en la cartera de Finanzas.
                  {showOperacionesTab && ' Si solo quieres ver lo que el equipo registró desde "Cobros y pagos", esa vista está en la pestaña Operaciones.'}
                </CardDescription>
              </div>
              <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto">
                <Input
                  placeholder="Buscar alumno, padre o concepto..."
                  value={historySearch}
                  onChange={(e) => setHistorySearch(e.target.value)}
                  className="w-full sm:w-64 h-9"
                />
                {/* Rango por FECHA DEL PAGO (no de emisión del cobro) con dos
                    calendarios. Los atajos cubren la pregunta de todos los días,
                    "¿qué entró hoy?", que con bloques de meses no se podía hacer. */}
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-1">
                    <Input
                      type="date"
                      aria-label="Pagos desde"
                      title="Desde — fecha en que entró el pago"
                      value={historyFrom}
                      max={historyTo || todayColombia()}
                      onChange={(e) => setHistoryFrom(e.target.value)}
                      className="h-9 w-full sm:w-36"
                    />
                    <span className="text-xs text-muted-foreground shrink-0">a</span>
                    <Input
                      type="date"
                      aria-label="Pagos hasta"
                      title="Hasta — fecha en que entró el pago"
                      value={historyTo}
                      min={historyFrom}
                      onChange={(e) => setHistoryTo(e.target.value)}
                      className="h-9 w-full sm:w-36"
                    />
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {HISTORY_QUICK_RANGES.map(q => {
                      const active = historyFrom === q.from() && historyTo === q.to();
                      return (
                        <Button
                          key={q.label}
                          variant="ghost"
                          size="sm"
                          className={`h-6 px-2 text-[11px] ${active ? 'bg-muted font-semibold' : 'text-muted-foreground'}`}
                          onClick={() => { setHistoryFrom(q.from()); setHistoryTo(q.to()); }}
                        >
                          {q.label}
                        </Button>
                      );
                    })}
                  </div>
                </div>
                <select
                  className="flex h-9 w-full sm:w-40 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  value={historyTeamFilter}
                  onChange={(e) => setHistoryTeamFilter(e.target.value)}
                >
                  <option value="all">Todos los Equipos</option>
                  {activeTeams.map(team => (
                    <option key={team.id} value={team.name}>{team.name}</option>
                  ))}
                </select>
                <FiltroTipoDeCobro
                  variante="select"
                  conteos={historyCategoryCounts}
                  valor={historyCategoryFilter}
                  onChange={setHistoryCategoryFilter}
                />
              </div>
            </CardHeader>
            <CardContent className="p-0 sm:p-6">
              {/* Filtro por estado en tarjetas. 'Cancelado' es opt-in: no viene
                  en la carga base (son ~2.4k cobros anulados), por eso su
                  contador va en '—' hasta que se selecciona y se vuelve a
                  consultar al servidor. */}
              <div className="px-4 sm:px-0 pt-4 sm:pt-0 pb-4">
                <StatFilterBar
                  columns={6}
                  value={historyStatusFilter === 'all' ? null : historyStatusFilter}
                  onChange={(v) => setHistoryStatusFilter(v ?? 'all')}
                  items={[
                    { key: null, label: 'Total', value: historyBase.length, tone: 'neutral' },
                    { key: 'paid', label: 'Pagado', value: historyCounts.paid ?? 0, tone: 'emerald' },
                    { key: 'partial', label: 'Abono parcial', value: historyCounts.partial ?? 0, tone: 'blue' },
                    { key: 'glosado', label: 'En aclaración', value: historyCounts.glosado ?? 0, tone: 'orange' },
                    { key: 'rejected', label: 'Rechazado', value: historyCounts.rejected ?? 0, tone: 'rose' },
                    {
                      key: 'cancelled',
                      label: 'Cancelado',
                      value: historyStatusFilter === 'cancelled' ? (historyCounts.cancelled ?? 0) : '—',
                      tone: 'violet',
                    },
                  ]}
                />
              </div>
              {/* Si la consulta llegó al tope, el usuario tiene que saberlo: una
                  tabla truncada en silencio se lee como "esto es todo". */}
              {historyTruncated && (
                <div className="mx-4 sm:mx-0 mb-3 flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800">
                  <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                  <span>
                    Hay más de {(HISTORY_PAGE_SIZE * HISTORY_MAX_PAGES).toLocaleString('es-CO')} movimientos en este filtro y solo se cargaron esos.
                    Acota el rango de fechas o el estado para ver el resto.
                  </span>
                </div>
              )}
              {/* Mobile cards */}
              <div className="grid grid-cols-1 gap-3 p-4 md:hidden">
                {historyPayments.length === 0 ? (
                  <p className="text-center text-muted-foreground py-8">No hay historial disponible.</p>
                ) : pagedHistory.map((payment) => {
                  const cfg = STATUS_CONFIG[payment.status] ?? { label: payment.status, className: 'bg-gray-100 text-gray-600' };
                  const g = grupoHistorial.get(payment.id);
                  return (
                    <div key={payment.id} className={`border p-4 space-y-2 ${g?.continua ? '-mt-3 rounded-t-none border-t-0' : 'rounded-t-lg'} ${g?.sigue ? 'rounded-b-none' : 'rounded-b-lg'}`}>
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          {!g?.continua && (
                            <div className="flex items-center gap-1.5 min-w-0">
                              <p className="font-medium text-sm truncate">{payment.athlete_name || 'Sin nombre'}</p>
                              {payment.asiste_externo && <ExternoBadge />}
                            </div>
                          )}
                          <div className="flex gap-1 flex-wrap mt-0.5">
                            <TipoDeCobroBadge payment={payment} className="max-w-full" />
                            {payment.team?.name && (
                              <Badge variant="outline" className="text-[10px] bg-red-50 text-red-700 border-red-200 py-0 h-4">
                                <Trophy className="h-2.5 w-2.5 mr-1" /> {payment.team.name}
                              </Badge>
                            )}
                            {(payment as any).plan?.name && (
                              <Badge variant="outline" className="text-[10px] bg-purple-50 text-purple-700 border-purple-200 py-0 h-4">
                                <Zap className="h-2.5 w-2.5 mr-1" /> {(payment as any).plan.name}
                              </Badge>
                            )}
                            {(payment as any).period_label && (
                              <Badge variant="outline" className="text-[10px] bg-blue-50 text-blue-700 border-blue-200 py-0 h-4">
                                Cubre {(payment as any).period_label}
                              </Badge>
                            )}
                            {showBranchCol && <BranchChip branchId={payment.branch_id} branches={branches} className="h-4" />}
                            {!payment.team?.name && !(payment as any).plan?.name && (
                              <span className="text-xs text-muted-foreground truncate">{payment.concept}</span>
                            )}
                          </div>
                        </div>
                        <div className="text-right shrink-0">
                          <p className="font-bold text-sm">{formatCurrency(payment.amount)}</p>
                          <Badge variant="outline" className={`text-xs ${cfg.className}`}>{cfg.label}</Badge>
                          {payment.reconciliation_status === 'pendiente' && (
                            <Badge variant="outline" className="text-[10px] bg-amber-50 text-amber-700 border-amber-200 py-0 h-4 ml-1" title="Aprobado; pendiente de conciliación bancaria">
                              pend. conciliación
                            </Badge>
                          )}
                          {(payment as any).last_failure_reason && (
                            <span className="block mt-1">
                              <FailedAttemptChip
                                reason={(payment as any).last_failure_reason}
                                at={(payment as any).last_failure_at}
                              />
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          {/* Misma corrección que en la tabla: la fecha del pago, no la de emisión. */}
                          <p className="text-xs text-muted-foreground whitespace-nowrap">{reportedDate(payment)}</p>
                          <PaymentOriginBadge payment={payment} compact />
                        </div>
                        {payment.receipt_url && (
                          <Button variant="ghost" size="sm" className="h-7 text-blue-600 hover:bg-blue-50 shrink-0" onClick={() => handleShowProof(payment)}>
                            <Eye className="h-3.5 w-3.5 mr-1" /> Ver
                          </Button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
              {/* Desktop table */}
              <div className="hidden md:block overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      {/* "Fecha" a secas se leía como la del cobro y la escuela
                          creía que un pago de hoy era del 30 de julio. */}
                      <TableHead>Fecha de pago</TableHead>
                      <TableHead>Deportista</TableHead>
                      <TableHead>Concepto</TableHead>
                      {showBranchCol && <TableHead>Sede</TableHead>}
                      <TableHead>Monto</TableHead>
                      <TableHead>Entró por</TableHead>
                      <TableHead>Estado</TableHead>
                      <TableHead>Soporte</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {historyPayments.length === 0 ? (
                      <TableRow><TableCell colSpan={showBranchCol ? 8 : 7} className="text-center py-8 text-muted-foreground">No se encontraron transacciones con los filtros actuales.</TableCell></TableRow>
                    ) : pagedHistory.map((payment) => {
                      const cfg = STATUS_CONFIG[payment.status] ?? { label: payment.status, className: 'bg-gray-100 text-gray-600' };
                      const g = grupoHistorial.get(payment.id);
                      return (
                        <TableRow key={payment.id} className={g?.sigue ? 'border-b-0' : undefined}>
                          {/* CUÁNDO ENTRÓ LA PLATA, no cuándo se emitió el cobro. Con
                              `created_at` la mensualidad de agosto generada el 30/jul se leía
                              como un pago "del 30 de jul" aunque el comprobante fuera del 3 de
                              agosto — el mismo error ya corregido en "Cobros por Aprobar". */}
                          <TableCell
                            className="text-xs text-muted-foreground whitespace-nowrap"
                            title={payment.payment_date ? `Cobro emitido el ${formatDate(payment.created_at)}` : undefined}
                          >
                            {g?.continua ? null : reportedDate(payment)}
                          </TableCell>
                          <TableCell className="font-medium">
                            <div className={`flex flex-col ${g?.continua ? 'invisible' : ''}`}>
                              <span className="flex items-center gap-1.5">
                                <span className="font-bold">{payment.athlete_name || 'Sin nombre'}</span>
                                {payment.asiste_externo && <ExternoBadge />}
                              </span>
                              <span className="text-xs text-muted-foreground">
                                {(payment as any).parent_responsible || <span className="text-muted-foreground text-xs">—</span>}
                              </span>
                            </div>
                          </TableCell>
                          <TableCell className="text-sm">
                            <div className="font-medium text-blue-600 mb-1">{payment.concept}</div>
                            <div className="flex flex-col gap-1">
                              <TipoDeCobroBadge payment={payment} />
                              {payment.team?.name && (
                                <Badge variant="outline" className="text-[10px] bg-red-50 text-red-700 border-red-200 w-fit">
                                  <Trophy className="h-3 w-3 mr-1" /> {payment.team.name}
                                </Badge>
                              )}
                              {(payment as any).plan?.name && (
                                <Badge variant="outline" className="text-[10px] bg-purple-50 text-purple-700 border-purple-200 w-fit">
                                  <Zap className="h-3 w-3 mr-1" /> {(payment as any).plan.name}
                                </Badge>
                              )}
                              {/* QUÉ MES CUBRE. El concepto es texto libre y hay cinco
                                  generadores distintos ("Plan PLAN PRO", "Mensualidad", …):
                                  varios no nombran el mes, así que sin este chip no hay forma
                                  de saber a qué periodo se imputó la plata. */}
                              {(payment as any).period_label && (
                                <Badge variant="outline" className="text-[10px] bg-blue-50 text-blue-700 border-blue-200 w-fit">
                                  Cubre {(payment as any).period_label}
                                </Badge>
                              )}
                            </div>
                          </TableCell>
                          {showBranchCol && (
                            <TableCell><BranchChip branchId={payment.branch_id} branches={branches} /></TableCell>
                          )}
                          <TableCell className="font-semibold">{formatCurrency(payment.amount)}</TableCell>
                          {/* Antes: {payment.payment_method || 'TRANSFER'} — inventaba
                              "TRANSFER" en los pagos sin método registrado. */}
                          <TableCell><PaymentOriginBadge payment={payment} /></TableCell>
                          <TableCell>
                            <Badge variant="outline" className={`text-xs ${cfg.className}`}>{cfg.label}</Badge>
                            {/* El intento fallido es un hecho aparte del estado: el cobro
                                puede seguir pendiente Y haber tenido un rechazo. */}
                            {(payment as any).last_failure_reason && (
                              <span className="block mt-1">
                                <FailedAttemptChip
                                  reason={(payment as any).last_failure_reason}
                                  at={(payment as any).last_failure_at}
                                />
                              </span>
                            )}
                          </TableCell>
                          <TableCell>
                            {payment.receipt_url ? (
                              <Button variant="ghost" size="sm" className="h-8 text-blue-600 hover:bg-blue-50" onClick={() => handleShowProof(payment)}>
                                <Eye className="h-4 w-4" />
                              </Button>
                            ) : <span className="text-xs text-muted-foreground">N/A</span>}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
              <TableRefreshBar
                className="-mx-0 sm:-mx-6 sm:-mb-6 mt-2 sm:rounded-b-lg"
                onRefresh={fetchPayments}
                loading={loading}
                summary={
                  historyTotalPages > 1
                    ? `Página ${historyPage} de ${historyTotalPages} · ${historyPayments.length} transacciones`
                    : `${historyPayments.length} transacciones`
                }
              >
                {historyTotalPages > 1 && (
                  <>
                    <Button variant="outline" size="sm" disabled={historyPage <= 1}
                      onClick={() => setHistoryPage((p) => Math.max(1, p - 1))}>Anterior</Button>
                    <Button variant="outline" size="sm" disabled={historyPage >= historyTotalPages}
                      onClick={() => setHistoryPage((p) => Math.min(historyTotalPages, p + 1))}>Siguiente</Button>
                  </>
                )}
              </TableRefreshBar>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Tab: Operaciones de «Cobros y pagos» (cobros-multiples §10.5) ── */}
        {showOperacionesTab && (
          <TabsContent value="operaciones">
            <OperacionesTab canManage={canManageCharges(currentUserRole)} />
          </TabsContent>
        )}

        {/* ── Tab: Cierre de Mes (F1) ──────────────────────────────────── */}
        <TabsContent value="cierre">
          <MonthCloseTab schoolId={schoolId} activeBranchId={activeBranchId} />
        </TabsContent>

        {/* ── Tab: Configuración (sin cambios de lógica, solo responsive) ── */}
        {/* ── Tab: Débito automático (F3) ──────────────────────────────── */}
        <TabsContent value="debito">
          {schoolId ? (
            <DebitoAutomaticoPanel schoolId={schoolId} />
          ) : (
            <p className="text-sm text-muted-foreground">Selecciona una escuela para ver el débito automático.</p>
          )}
        </TabsContent>

        <TabsContent value="config" className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">Configuración</h2>
              <p className="text-sm text-muted-foreground">Reglas de facturación, mora y notificaciones.</p>
            </div>
            <Button onClick={handleSaveBilling} disabled={billingSaving} className="gap-2 w-full sm:w-auto">
              {billingSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Guardar Cambios
            </Button>
          </div>
          {billing && (
            <div className="grid gap-6 md:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base"><DollarSign className="h-5 w-5 text-emerald-500" />Reglas de Cobro</CardTitle>
                  <CardDescription>Cuándo y cómo se generan los cobros mensuales.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-5">
                  <div className="space-y-2">
                    <Label htmlFor="due_day">Día de corte del mes</Label>
                    <div className="flex items-center gap-2">
                      <NumberStepper
                        min={1} max={31} className="w-28 h-9"
                        value={billing.payment_cutoff_day}
                        onChange={v => updateBilling('payment_cutoff_day', v === "" ? 5 : v)}
                      />
                      <span className="text-sm text-muted-foreground">de cada mes</span>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label>Ciclo de facturación</Label>
                    <div className="grid grid-cols-1 gap-2">
                      {([
                        {
                          value: 'prorated',
                          label: 'Prorrateado automático',
                          desc: 'El primer cobro es proporcional a los días restantes del mes.',
                        },
                        {
                          value: 'fixed_calendar',
                          label: 'Mensualidad fija por calendario',
                          desc: 'Siempre cobra el mes completo. Vence en el día de corte.',
                        },
                        {
                          value: 'rolling_30',
                          label: 'Ciclo de 30 días desde inscripción',
                          desc: 'Cada cobro vence exactamente 30 días después del anterior.',
                        },
                      ] as const).map(opt => (
                        <button
                          key={opt.value}
                          type="button"
                          onClick={() => updateBilling('billing_cycle_type', opt.value)}
                          className={`text-left p-3 rounded-lg border-2 transition-colors ${
                            billing.billing_cycle_type === opt.value
                              ? 'border-primary bg-primary/5'
                              : 'border-muted hover:border-primary/40'
                          }`}
                        >
                          <p className="font-medium text-sm">{opt.label}</p>
                          <p className="text-xs text-muted-foreground mt-0.5">{opt.desc}</p>
                        </button>
                      ))}
                    </div>
                  </div>
                  {/* F7 — solo el owner decide si la escuela cobra por clases restantes. */}
                  {(currentUserRole === 'owner' || currentUserRole === 'super_admin') && remainingClassesColumnReady.current && (
                    <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
                      <div>
                        <Label className="font-medium">Alta a mitad de mes por clases restantes</Label>
                        <p className="text-xs text-muted-foreground max-w-[46ch]">
                          Con mensualidad fija por calendario, al inscribir a alguien a mitad de mes
                          puedes cobrarle solo las clases que le quedan y el mes siguiente completo.
                          Requiere planes con horas o número de clases definido.
                        </p>
                      </div>
                      <Switch
                        checked={!!billing.remaining_classes_billing_enabled}
                        onCheckedChange={v => updateBilling('remaining_classes_billing_enabled', v)}
                      />
                    </div>
                  )}
                  <div className="space-y-2">
                    <Label htmlFor="grace">Días de gracia</Label>
                    <div className="flex items-center gap-2">
                      <NumberStepper
                        min={0} max={15} className="w-28 h-9"
                        value={billing.payment_grace_days}
                        onChange={v => updateBilling('payment_grace_days', v === "" ? 0 : v)}
                      />
                      <span className="text-sm text-muted-foreground">días después del corte</span>
                    </div>
                  </div>
                  <Separator />
                  <div className="flex items-center justify-between">
                    <div>
                      <Label className="font-medium">Generar cobros automáticos</Label>
                      <p className="text-xs text-muted-foreground">Crear pagos pendientes cada mes</p>
                    </div>
                    <Switch checked={billing.auto_generate_payments} onCheckedChange={v => updateBilling('auto_generate_payments', v)} />
                  </div>
                  <Separator />
                  <div className="flex items-center justify-between">
                    <div>
                      <Label className="font-medium">Descuento por pronto pago</Label>
                      <p className="text-xs text-muted-foreground">Premia a quien paga apenas se genera el cobro</p>
                    </div>
                    <Switch
                      checked={billing.early_payment_discount_enabled}
                      onCheckedChange={v => updateBilling('early_payment_discount_enabled', v)}
                    />
                  </div>
                  {billing.early_payment_discount_enabled && (
                    <div className="space-y-3 p-3 rounded-lg border bg-muted/30">
                      <div className="space-y-2">
                        <Label htmlFor="epd_mode">Hasta cuándo vale</Label>
                        <select
                          id="epd_mode"
                          className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                          value={billing.early_payment_discount_mode ?? 'days_from_creation'}
                          onChange={e => updateBilling('early_payment_discount_mode', e.target.value as 'days_from_creation' | 'day_of_month')}
                        >
                          <option value="days_from_creation">Unos días desde que se genera el cobro</option>
                          <option value="day_of_month">Hasta un día fijo del mes</option>
                        </select>
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="epd_days">{billing.early_payment_discount_mode === 'day_of_month' ? 'Día del mes' : 'Días de vigencia'}</Label>
                        <div className="flex items-center gap-2">
                          <NumberStepper
                            min={1} max={billing.early_payment_discount_mode === 'day_of_month' ? 28 : 30} className="w-28 h-9"
                            value={billing.early_payment_discount_days}
                            onChange={v => updateBilling('early_payment_discount_days', v === "" ? 5 : v)}
                          />
                          <span className="text-sm text-muted-foreground">
                            {billing.early_payment_discount_mode === 'day_of_month'
                              ? 'el descuento vale hasta ese día del mes en que se genera el cobro'
                              : 'días desde que se genera el cobro'}
                          </span>
                        </div>
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="epd_pct">Porcentaje de descuento</Label>
                        <div className="flex items-center gap-2">
                          <NumberStepper
                            min={1} max={50} className="w-28 h-9"
                            value={billing.early_payment_discount_percentage}
                            onChange={v => updateBilling('early_payment_discount_percentage', v === "" ? 0 : v)}
                          />
                          <span className="text-sm text-muted-foreground">% de descuento</span>
                        </div>
                      </div>
                      <p className="text-[11px] text-muted-foreground leading-snug">
                        No aplica si el deportista tiene otro cobro pendiente o vencido de un mes anterior en esta escuela.
                      </p>
                    </div>
                  )}
                  <Separator />
                  <div className="flex items-center justify-between" data-testid="sibling-discount-toggle-row">
                    <div>
                      <Label className="font-medium">Descuento por hermanos</Label>
                      <p className="text-xs text-muted-foreground">Se aplica solo, desde el 2do hijo activo de la misma familia</p>
                    </div>
                    <Switch
                      checked={billing.sibling_discount_enabled}
                      onCheckedChange={v => updateBilling('sibling_discount_enabled', v)}
                    />
                  </div>
                  {billing.sibling_discount_enabled && (
                    <div className="space-y-3 p-3 rounded-lg border bg-muted/30" data-testid="sibling-discount-percentage-block">
                      <SiblingTiersEditor
                        tiers={normalizeSiblingTiers(billing.sibling_discount_tiers, billing.sibling_discount_percentage)}
                        onChange={tiers => setBilling(b => b ? { ...b, sibling_discount_tiers: tiers, sibling_discount_percentage: tiers[0] ?? 0 } : b)}
                      />
                      <p className="text-[11px] text-muted-foreground leading-snug">
                        El primer hijo (la inscripción activa más antigua) paga completo; desde el 2.º cada hermano activo en esta escuela lleva el descuento de su escalón. Se recalcula cada mes: si un hermano se retira, los demás suben de puesto solos.
                      </p>
                    </div>
                  )}

                </CardContent>
              </Card>

              {/* Descuento por referidos: solo aparece si la escuela ya tiene campaña
                  (o si quien mira es administración de plataforma y puede crearla). */}
              {schoolId && canManageCharges(currentUserRole) && (
                <>
                  <ReferidosPanel schoolId={schoolId} puedeCrear={esPlatformAdmin} />
                  {/* Pago por plazos: ajustes (visibles solo para el administrador de plataforma: prenden la función
                      por escuela) y bandeja de acuerdos (solo con la función prendida). */}
                  {esPlatformAdmin && <AjustesAcuerdos schoolId={schoolId} />}
                  <BandejaAcuerdos schoolId={schoolId} />
                </>
              )}

              {/* Catálogos vendibles (20260908152538) — el toggle lo prende SOLO
                  SportMaps (panel interno); si está activo, la escuela administra
                  aquí el contenido (ítems/precios). */}
              {schoolId && (
                <SellableCatalogCard
                  schoolId={schoolId}
                  table="school_merchandise_items"
                  enabled={billing.merchandise_enabled}
                  title="Catálogo de artículos deportivos"
                  description="Guayos, uniformes, accesorios — se cobran aparte de mensualidad/inscripción."
                  itemLabel="artículo"
                  withSizesAndImage
                />
              )}
              {schoolId && (
                <SellableCatalogCard
                  schoolId={schoolId}
                  table="school_tournament_items"
                  enabled={billing.tournament_charges_enabled}
                  title="Cobros sueltos"
                  description='Torneos, clases extra o de perfeccionamiento, vacacionales y viajes. Ej. "Torneo Interclubes — $50.000": un cobro simple, separado de mensualidad/inscripción/artículos.'
                  itemLabel="cobro"
                  withServiceFields
                  linkTournaments
                />
              )}

              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base"><Clock className="h-5 w-5 text-amber-500" />Mora y Penalización</CardTitle>
                  <CardDescription>Recargos por pago tardío.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-5">
                  <div className="flex items-center justify-between">
                    <div>
                      <Label className="font-medium">Habilitar mora</Label>
                      <p className="text-xs text-muted-foreground">Recargo después del período de gracia</p>
                    </div>
                    <Switch checked={billing.late_fee_enabled} onCheckedChange={v => updateBilling('late_fee_enabled', v)} />
                  </div>
                  {billing.late_fee_enabled && (
                    <div className="space-y-2 p-3 rounded-lg border bg-muted/30">
                      <Label htmlFor="late_pct">Porcentaje de recargo</Label>
                      <div className="flex items-center gap-2">
                        <NumberStepper
                          min={1} max={50} className="w-28 h-9"
                          value={billing.late_fee_percentage}
                          onChange={v => updateBilling('late_fee_percentage', v === "" ? 5 : v)}
                        />
                        <span className="text-sm text-muted-foreground">% adicional</span>
                      </div>
                      <p className="text-[11px] text-muted-foreground leading-snug">
                        Se aplica automáticamente una sola vez sobre el saldo pendiente cuando el pago
                        supera la fecha de vencimiento más los {billing.payment_grace_days} días de gracia.
                        El recargo se suma al monto a cobrar y el pago pasa a “Vencido”.
                      </p>
                    </div>
                  )}
                  {/* ── Pausa por vacaciones / lesión ───────────────────── */}
                  <div className="flex items-center justify-between pt-2 border-t">
                    <div>
                      <Label className="font-medium">🏖️ Permitir pausa por vacaciones</Label>
                      <p className="text-xs text-muted-foreground">
                        Durante la pausa no se le generan cobros ni aparece en la lista de asistencia
                      </p>
                    </div>
                    <Switch checked={billing.pause_enabled} onCheckedChange={v => updateBilling('pause_enabled', v)} />
                  </div>
                  {billing.pause_enabled && (
                    <div className="space-y-3 p-3 rounded-lg border bg-muted/30">
                      <div className="space-y-2">
                        <Label htmlFor="pause_max">Tope de meses por año</Label>
                        <div className="flex items-center gap-2">
                          <NumberStepper
                            min={0} max={12} className="w-28 h-9"
                            value={billing.pause_max_months_per_year}
                            onChange={v => updateBilling('pause_max_months_per_year', v === "" ? 2 : v)}
                          />
                          <span className="text-sm text-muted-foreground">mes(es) por atleta</span>
                        </div>
                        <p className="text-[11px] text-muted-foreground leading-snug">
                          En 0 no hay tope automático. La pausa se toma por meses completos: solo se
                          salta el cobro de los meses que cubre enteros, y los cobros pendientes de
                          esos meses se anulan.
                        </p>
                      </div>
                      <div className="flex items-center justify-between pt-1 border-t">
                        <div>
                          <Label className="font-medium text-sm">El acudiente puede solicitarla</Label>
                          <p className="text-[11px] text-muted-foreground">
                            La solicita desde su app y la administración la aprueba. Apagado, solo la aplica la administración.
                          </p>
                        </div>
                        <Switch
                          checked={billing.pause_parent_can_request}
                          onCheckedChange={v => updateBilling('pause_parent_can_request', v)}
                        />
                      </div>
                    </div>
                  )}
                  <div className="flex items-center justify-between pt-2">
                    <div>
                      <Label className="font-medium">Exigir comprobante</Label>
                      <p className="text-xs text-muted-foreground">Los padres deben subir foto del recibo</p>
                    </div>
                    <Switch checked={billing.require_payment_proof} onCheckedChange={v => updateBilling('require_payment_proof', v)} />
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base"><CheckCircle2 className="h-5 w-5 text-green-500" />Validación automática de comprobantes</CardTitle>
                  <CardDescription>El sistema lee el comprobante y decide por reglas (el servidor nunca confía en el cliente).</CardDescription>
                </CardHeader>
                <CardContent className="space-y-5">
                  <div className="flex items-center justify-between">
                    <div className="pr-4">
                      <Label className="font-medium">Auto-aprobar comprobantes verdes</Label>
                      <p className="text-xs text-muted-foreground">
                        Un comprobante nítido, del monto exacto, a tu cuenta, con fecha reciente y no
                        duplicado se aprueba solo (doble lectura del servidor). Requiere 2 proveedores OCR.
                      </p>
                    </div>
                    <Switch checked={billing.auto_approve_enabled} onCheckedChange={v => updateBilling('auto_approve_enabled', v)} />
                  </div>
                  {billing.auto_approve_enabled && (
                    <div className="space-y-2 p-3 rounded-lg border bg-muted/30">
                      <Label htmlFor="auto_approve_max">Tope de auto-aprobación (COP)</Label>
                      <div className="flex items-center gap-2">
                        <Input
                          id="auto_approve_max"
                          type="number"
                          min={0}
                          className="w-40 h-9"
                          value={billing.auto_approve_max_amount || ''}
                          onChange={e => updateBilling('auto_approve_max_amount', Number(e.target.value) || 0)}
                        />
                        <span className="text-sm text-muted-foreground">máx. por pago</span>
                      </div>
                      <p className="text-[11px] text-muted-foreground leading-snug">
                        Solo se auto-aprueban cobros de <strong>{formatCurrency(billing.auto_approve_max_amount || 0)}</strong> o menos.
                        Montos mayores siempre pasan por revisión manual. Déjalo en 0 para no auto-aprobar por monto.
                      </p>
                    </div>
                  )}
                  <Separator />
                  <div className="flex items-center justify-between">
                    <div className="pr-4">
                      <Label className="font-medium">Abrir glosa automática</Label>
                      <p className="text-xs text-muted-foreground">
                        Si un comprobante tiene inconsistencias (monto/fecha/referencia), el sistema abre
                        una aclaración al acudiente en vez de dejarlo en revisión manual.
                      </p>
                    </div>
                    <Switch checked={billing.auto_glosa_enabled} onCheckedChange={v => updateBilling('auto_glosa_enabled', v)} />
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base"><Bell className="h-5 w-5 text-blue-500" />Recordatorios</CardTitle>
                  <CardDescription>Notificaciones automáticas de pago.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-5">
                  <div className="flex items-center justify-between">
                    <div>
                      <Label className="font-medium">Enviar recordatorios</Label>
                      <p className="text-xs text-muted-foreground">Notificar antes del vencimiento</p>
                    </div>
                    <Switch checked={billing.reminder_enabled} onCheckedChange={v => updateBilling('reminder_enabled', v)} />
                  </div>
                  {billing.reminder_enabled && (
                    <div className="space-y-2 p-3 rounded-lg border bg-muted/30">
                      <Label htmlFor="reminder_days">Días antes del vencimiento</Label>
                      <div className="flex items-center gap-2">
                        <NumberStepper
                          min={1} max={15} className="w-28 h-9"
                          value={billing.reminder_days_before}
                          onChange={v => updateBilling('reminder_days_before', v === "" ? 3 : v)}
                        />
                        <span className="text-sm text-muted-foreground">días antes</span>
                      </div>
                    </div>
                  )}
                  <Separator />
                  <div className="flex items-center justify-between">
                    <div className="pr-4">
                      <Label className="font-medium">Avisos de cobranza</Label>
                      <p className="text-xs text-muted-foreground">
                        Interruptor general. Apagado, la escuela no manda ningún aviso de cobro. Prendido, cada aviso de abajo se maneja por separado.
                      </p>
                    </div>
                    <Switch checked={billing.charge_notifications_enabled} onCheckedChange={v => updateBilling('charge_notifications_enabled', v)} />
                  </div>
                  {billing.charge_notifications_enabled && avisosColumnsReady.current && (
                    <div className="space-y-3 p-3 rounded-lg border bg-muted/30" data-testid="avisos-de-cobranza">
                      {([
                        ['charge_created_notice_enabled', 'Cobro generado', 'Un aviso cuando se crea la mensualidad o un cobro nuevo.', true],
                        ['collection_pre_due_enabled', 'Antes de vencer', 'Recordatorios 3 días antes, el día anterior y el día del vencimiento (WhatsApp o correo, según los canales de abajo).', true],
                        ['overdue_notices_enabled', 'Mora', 'Aviso de cobro vencido y recordatorios a los 3, 10 y 20 días. Apagado: ningún mensaje de moroso.', true],
                        ['monthly_statement_enabled', 'Estado de cuenta mensual', 'Un resumen mensual de lo que debe cada familia.', true],
                      ] as const).map(([campo, titulo, ayuda, porDefecto]) => (
                        <div key={campo} className="flex items-center justify-between gap-3">
                          <div className="pr-2">
                            <Label className="text-sm font-medium">{titulo}</Label>
                            <p className="text-[11px] text-muted-foreground leading-snug">{ayuda}</p>
                          </div>
                          <Switch
                            checked={(billing[campo] ?? porDefecto) !== false}
                            onCheckedChange={v => updateBilling(campo, v)}
                          />
                        </div>
                      ))}
                      <Separator />
                      <p className="text-xs font-medium">Canales de los recordatorios (antes de vencer y mora)</p>
                      <div className="flex items-center justify-between gap-3">
                        <Label className="text-sm">Por WhatsApp (solo a quien aceptó recibirlos)</Label>
                        <Switch
                          checked={billing.whatsapp_collection_reminders_enabled === true}
                          onCheckedChange={v => updateBilling('whatsapp_collection_reminders_enabled', v)}
                        />
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <Label className="text-sm">Por correo</Label>
                        <Switch
                          checked={billing.email_collection_reminders_enabled === true}
                          onCheckedChange={v => updateBilling('email_collection_reminders_enabled', v)}
                        />
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base"><Shield className="h-5 w-5 text-purple-500" />Permisos</CardTitle>
                  <CardDescription>Qué pueden hacer los coaches y el staff.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-5">
                  <div className="flex items-center justify-between">
                    <div>
                      <Label className="font-medium">Coaches pueden enviar mensajes</Label>
                      <p className="text-xs text-muted-foreground">Comunicación directa coach → padres</p>
                    </div>
                    <Switch checked={billing.allow_coach_messaging} onCheckedChange={v => updateBilling('allow_coach_messaging', v)} />
                  </div>
                  <Separator />
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <Label className="font-medium">Coaches pueden inscribir en equipos con cobro</Label>
                      <p className="text-xs text-muted-foreground max-w-[46ch]">
                        Inscribir a un atleta en un equipo con mensualidad le genera el cobro en
                        la apertura del mes. Si lo apagas, esas inscripciones las hace la escuela.
                        Asignar planes de pago nunca lo puede hacer un entrenador.
                      </p>
                    </div>
                    <Switch
                      checked={billing.coach_can_enroll_paid_teams}
                      onCheckedChange={v => updateBilling('coach_can_enroll_paid_teams', v)}
                    />
                  </div>
                  <Separator />
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <Label className="font-medium">Coaches pueden subir hojas de matrícula</Label>
                      <p className="text-xs text-muted-foreground max-w-[46ch]">
                        El entrenador toma la foto de la hoja en papel y la sube; la escuela revisa
                        los datos y crea al deportista. El entrenador no ve la bandeja ni aprueba.
                      </p>
                    </div>
                    <Switch
                      checked={!!billing.coach_can_upload_enrollment_forms}
                      onCheckedChange={v => updateBilling('coach_can_upload_enrollment_forms', v)}
                    />
                  </div>
                  <Separator />
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <Label className="font-medium">Coaches pueden subir planillas de asistencia</Label>
                      <p className="text-xs text-muted-foreground max-w-[46ch]">
                        Foto de la planilla en papel de sus equipos, desde la app o el WhatsApp de la escuela.
                        Sin este permiso, solo la administración puede subirlas.
                      </p>
                    </div>
                    <Switch
                      checked={!!billing.coach_can_upload_attendance_sheets}
                      onCheckedChange={v => updateBilling('coach_can_upload_attendance_sheets', v)}
                    />
                  </div>
                  <Separator />
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <Label className="font-medium">Coaches pueden remover deportistas de sus equipos</Label>
                      <p className="text-xs text-muted-foreground max-w-[46ch]">
                        Al remover, la inscripción se cancela y se anulan los cobros pendientes del
                        deportista. Solo aplica a sus equipos; los planes los maneja la administración.
                      </p>
                    </div>
                    <Switch
                      checked={!!billing.coach_can_remove_enrollments}
                      onCheckedChange={v => updateBilling('coach_can_remove_enrollments', v)}
                    />
                  </div>
                </CardContent>
              </Card>
              {/* Datos de Pago — full width */}
              <Card className="md:col-span-2">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base"><CreditCard className="h-5 w-5 text-indigo-500" />Datos de Pago para Transferencia</CardTitle>
                  <CardDescription>Esta información la verán los acudientes al elegir pago manual.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="bank_name">Nombre del Banco</Label>
                      <Input id="bank_name" placeholder="Ej: Bancolombia" value={billing.bank_name || ''} onChange={e => updateBilling('bank_name', e.target.value)} />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="bank_account_type">Tipo de Cuenta</Label>
                      <select id="bank_account_type" className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" value={billing.bank_account_type || ''} onChange={e => updateBilling('bank_account_type', e.target.value)}>
                        <option value="">Selecciona tipo</option>
                        <option value="ahorros">Ahorros</option>
                        <option value="corriente">Corriente</option>
                        <option value="billetera_digital">Billetera Digital</option>
                      </select>
                    </div>
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <Label htmlFor="bank_account_number">Número de Cuenta</Label>
                        <Button variant="ghost" size="sm" className="h-6 px-2" onClick={() => setShowSensitive(!showSensitive)}>
                          {showSensitive ? <EyeOff className="h-3.5 w-3.5 mr-1" /> : <Eye className="h-3.5 w-3.5 mr-1" />}
                          {showSensitive ? "Ocultar" : "Mostrar"}
                        </Button>
                      </div>
                      <Input 
                        id="bank_account_number" 
                        placeholder="Ej: 123-456789-01" 
                        value={showSensitive ? (billing.bank_account_number || '') : maskSensitive(billing.bank_account_number)} 
                        onChange={e => updateBilling('bank_account_number', e.target.value)} 
                        onFocus={() => setShowSensitive(true)}
                      />
                    </div>
                  </div>
                  <Separator />
                  <PaymentAccountsEditor
                    accounts={billing.payment_accounts ?? []}
                    onChange={next => updateBilling('payment_accounts', next)}
                    showSensitive={showSensitive}
                    onReveal={() => setShowSensitive(true)}
                  />
                  <Separator />
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="bank_titular_name">Nombre del Titular</Label>
                      <Input id="bank_titular_name" placeholder="Titular de la cuenta" value={billing.bank_titular_name || ''} onChange={e => updateBilling('bank_titular_name', e.target.value)} />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="bank_titular_id">NIT o Cédula del Titular</Label>
                      <Input 
                        id="bank_titular_id" 
                        placeholder="Documento" 
                        value={showSensitive ? (billing.bank_titular_id || '') : maskSensitive(billing.bank_titular_id)} 
                        onChange={e => updateBilling('bank_titular_id', e.target.value)} 
                        onFocus={() => setShowSensitive(true)}
                      />
                    </div>
                  </div>
                  <Separator />
                  <div className="space-y-4">
                    <div>
                      <Label>Código QR para Transferencia</Label>
                      <p className="text-xs text-muted-foreground mb-4">Este QR se mostrará con los datos bancarios.</p>
                    </div>
                    {billing.payment_qr_url ? (
                      <div className="flex flex-col sm:flex-row items-start gap-4 p-4 border rounded-lg bg-muted/30">
                        <img src={billing.payment_qr_url} alt="QR de Pago" className="w-32 h-32 object-cover rounded-md border bg-white" />
                        <Button variant="destructive" size="sm" onClick={() => updateBilling('payment_qr_url', null)}>Eliminar QR</Button>
                      </div>
                    ) : (
                      <div className="p-4 border rounded-lg border-dashed">
                        <FileUpload bucket="school-assets" path={`qr/${schoolId}`} accept="image/*" onUploadComplete={(url) => updateBilling('payment_qr_url', url)} />
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>

              {/* SportMaps Pay. La key lo remonta cuando cambian las pasarelas
                  de abajo, para que el gate se re-evalúe sin recargar. */}
              <div className="md:col-span-2">
                <SportMapsPaySettings key={`pay-${revisionPasarelas}`} />
              </div>

              {/* Cuenta de recaudo propia. Solo staff de plataforma: §10 del plan
                  de connected-accounts decidió que a la escuela NO se le piden
                  llaves ni secretos (pegar la privada de Wompi es entregar la
                  capacidad de cobrar en su comercio). El camino del cliente es
                  el wizard "Conectar", que todavía no existe; mientras tanto la
                  conexión la hace soporte. Va pegado a SportMaps Pay porque el
                  aviso de ahí manda acá. Sin entrada de menú propia. */}
              {schoolId && esPlatformAdmin && (
                <div className="md:col-span-2">
                  <PaymentProvidersAdmin
                    schoolId={schoolId}
                    onChange={() => setRevisionPasarelas(n => n + 1)}
                  />
                </div>
              )}

              {/* Nueva Sección: Abonos */}
                <InstallmentsConfigCard 
                  settings={{
                    allow_installments: billing.allow_installments,
                    max_installments_per_payment: billing.max_installments_per_payment,
                    min_installment_amount: billing.min_installment_amount,
                    installment_require_proof: billing.installment_require_proof,
                  }}
                  onChange={(updated) => setBilling({ ...billing, ...updated })}
                />

                {/* Botón generar cobros pendientes */}
                <BackfillPaymentsCard
                  schoolId={schoolId}
                  billing={billing}
                  onSuccess={fetchPayments}
                />

            </div>
          )}
        </TabsContent>
      </Tabs>

      {/* Dialog comprobante */}
      <Dialog open={viewingProof.open} onOpenChange={open => setViewingProof(prev => ({ ...prev, open }))}>
        <DialogContent className="w-[95vw] max-w-2xl">
          <DialogHeader>
            <DialogTitle>Comprobante de Pago</DialogTitle>
            <DialogDescription>
              {viewingProof.student} — {formatCurrency(viewingProof.amount)}
              {viewingProof.group && <span className="block mt-1 font-semibold text-violet-700">{viewingProof.group}</span>}
            </DialogDescription>
          </DialogHeader>
          <div className="p-4 flex flex-col items-center justify-center bg-muted rounded-lg min-h-48 sm:min-h-72">
            {viewingProof.url ? (
              /\.pdf(\?|$)/i.test(viewingProof.url) ? (
                // Los comprobantes en PDF NO se renderizan con <img> (queda en
                // blanco). Se muestran en un <iframe>; con enlace de respaldo.
                <iframe
                  src={viewingProof.url}
                  title="Comprobante"
                  className="w-full h-[60dvh] rounded border-0 bg-white"
                />
              ) : (
                <img src={viewingProof.url} alt="Comprobante" className="max-h-list object-contain rounded w-full" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
              )
            ) : (
              <div className="text-center text-muted-foreground p-8"><p>No hay comprobante disponible.</p></div>
            )}
            {viewingProof.url && (
              <a
                href={viewingProof.url}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-3 text-sm text-primary underline"
              >
                Abrir en pestaña nueva
              </a>
            )}
          </div>
          <div className="flex justify-end">
            <Button variant="secondary" onClick={() => setViewingProof(prev => ({ ...prev, open: false }))}>Cerrar</Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Cash and Approval Modals */}
      <CobrosYPagosModal
        open={showCashModal}
        onOpenChange={setShowCashModal}
        onSuccess={fetchPayments}
        onViewOperations={() => setSearchParams(prev => {
          const next = new URLSearchParams(prev);
          next.set('tab', 'operaciones');
          return next;
        }, { replace: true })}
      />
      <ClasesDePruebaDialog
        open={showClasesPrueba}
        onOpenChange={setShowClasesPrueba}
        schoolId={schoolId}
        onPagado={fetchPayments}
      />
      <ApprovePaymentMethodSheet
        open={!!paymentToApprove}
        onOpenChange={(open) => !open && setPaymentToApprove(null)}
        payment={paymentToApprove}
        siblings={receiptSiblings(paymentToApprove)}
        // En un comprobante de varios meses el pie de foto quedó en uno solo.
        familyNote={paymentToApprove
          ? [paymentToApprove, ...receiptSiblings(paymentToApprove)].map(p => familyNotes[p.id]?.pie).find(Boolean) ?? null
          : null}
        onSuccess={() => {
          setPaymentToApprove(null);
          fetchPayments();
        }}
      />
      <RejectReceiptDialog
        payment={rejectingPayment}
        open={!!rejectingPayment}
        onOpenChange={(o) => { if (!o) setRejectingPayment(null); }}
        onSuccess={() => { setRejectingPayment(null); fetchPayments(); }}
      />
      <BulkApproveGreensDialog
        items={rawPendingPayments}
        open={bulkGreensOpen}
        onOpenChange={setBulkGreensOpen}
        onDone={fetchPayments}
        userId={user?.id}
        schoolId={schoolId}
        schoolName={schoolName}
      />
      <CreateGlosaDialog
        payment={creatingGlosaPayment}
        open={!!creatingGlosaPayment}
        onOpenChange={(o) => { if (!o) setCreatingGlosaPayment(null); }}
        onSuccess={() => { fetchPayments(); fetchGlosas(); }}
      />
      <GlosaConciliationDialog
        glosa={conciliatingGlosa}
        open={!!conciliatingGlosa}
        onOpenChange={(o) => { if (!o) setConciliatingGlosa(null); }}
        onSuccess={() => { fetchPayments(); fetchGlosas(); }}
      />
    </div>
  );
}

function BackfillPaymentsCard({
  schoolId, onSuccess,
}: {
  schoolId: string | null;
  billing?: BillingSettings | null;  // ya no se usa (F0: la generación es server-side); se mantiene por compat del padre
  onSuccess: () => void;
}) {
  const { toast } = useToast();
  const [loading, setLoading]   = useState(false);
  const [preview, setPreview]   = useState<any[]>([]);
  const [showPreview, setShowPreview] = useState(false);
  const [generating, setGenerating]  = useState(false);

  // Periodo a abrir = mes actual (hora Colombia). todayColombia() → 'YYYY-MM-DD'.
  const currentPeriod = () => {
    const [y, m] = todayColombia().split('-').map(Number);
    return { p_school_id: schoolId, p_year: y, p_month: m };
  };

  // F0: la vista previa ahora la calcula el servidor (preview_open_month) con la
  // MISMA lógica canónica que el cron. Se eliminó el cálculo client-side + el
  // prorrateo (calcFirstPayment): el prorrateo vive solo en el alta (checkout/QR).
  const loadPreview = async () => {
    if (!schoolId) return;
    setLoading(true);
    try {
      const { data, error } = await (supabase as any).rpc('preview_open_month', currentPeriod());
      if (error) throw error;
      setPreview(((data?.items) ?? []) as any[]);
      setShowPreview(true);
    } catch (e: any) {
      toast({ title: 'Error', description: e.message, variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  };

  // F0: genera vía RPC única open_month (advisory lock + dedup por mes + period
  // poblado). Se eliminó el INSERT client-side en loop (vulnerable a doble-clic).
  const handleGenerate = async () => {
    if (!schoolId || preview.length === 0) return;
    setGenerating(true);
    try {
      const { data, error } = await (supabase as any).rpc('open_month', currentPeriod());
      if (error) throw error;
      const n = data?.generados ?? 0;
      toast({
        title: `${n} pago(s) generado(s)`,
        description: 'Cobros del mes creados por la vía unificada.',
      });
      setShowPreview(false);
      setPreview([]);
      onSuccess();
    } catch (e: any) {
      toast({ title: 'Error al generar pagos', description: e.message, variant: 'destructive' });
    } finally {
      setGenerating(false);
    }
  };

  return (
    <Card className="border-amber-200">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <AlertTriangle className="h-5 w-5 text-amber-500" />
          {isCobrosYPagosEnabled() ? 'Abrir el mes' : 'Apertura del Mes — Generar Cobros'}
        </CardTitle>
        <CardDescription>
          Crea la mensualidad de este mes para los atletas inscritos que todavía no la tienen.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!showPreview ? (
          <Button variant="outline" onClick={loadPreview} disabled={loading} className="w-full">
            {loading
              ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Calculando...</>
              : <>Ver vista previa del mes a abrir</>}
          </Button>
        ) : preview.length === 0 ? (
          <div className="flex items-center gap-2 text-sm text-green-600">
            <CheckCircle2 className="h-4 w-4" />
            Todos los atletas tienen pagos registrados.
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Se generarán <strong>{preview.length} cobro(s)</strong> del mes (cuota completa):
            </p>
            <div className="rounded-lg border overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Atleta</TableHead>
                    <TableHead>Tipo</TableHead>
                    <TableHead>Monto</TableHead>
                    <TableHead>Vence</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {preview.map((row, i) => (
                    <TableRow key={i}>
                      <TableCell className="font-medium text-sm">{row.athlete}</TableCell>
                      <TableCell className="text-xs text-muted-foreground capitalize">
                        {row.tipo === 'menor' ? '🧒 Menor' : row.tipo === 'adulto' ? '🧑 Adulto' : '📋 No registrado'}
                      </TableCell>
                      <TableCell className="font-bold text-primary text-sm">
                        {new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 0 }).format(row.amount)}
                      </TableCell>
                      <TableCell className="text-xs">{row.due_date}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="flex gap-2">
              <Button onClick={handleGenerate} disabled={generating}>
                {generating
                  ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Generando...</>
                  : <>Confirmar y generar {preview.length} pago(s)</>}
              </Button>
              <Button variant="ghost" onClick={() => { setShowPreview(false); setPreview([]); }}>
                Cancelar
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Descuento por hermanos escalonado (F2) ─────────────────────────────────

const SIBLING_TIERS_MAX = 10;

/** tiers null/vacío → [percentage] (comportamiento previo a F2). */
function normalizeSiblingTiers(tiers: number[] | null | undefined, percentage: number): number[] {
  const clean = (tiers ?? [])
    .map(t => Number(t))
    .filter(t => Number.isFinite(t))
    .map(t => Math.min(100, Math.max(0, t)))
    .slice(0, SIBLING_TIERS_MAX);
  return clean.length > 0 ? clean : [Math.min(100, Math.max(0, Number(percentage) || 0))];
}

function siblingOrdinal(n: number): string {
  return `${n}.º`;
}

function SiblingTiersEditor({ tiers, onChange }: { tiers: number[]; onChange: (tiers: number[]) => void }) {
  const BASE = 100000;
  const setAt = (idx: number, raw: string) => {
    const n = raw === '' ? 0 : Math.min(100, Math.max(0, Number(raw)));
    const next = [...tiers];
    next[idx] = Number.isFinite(n) ? n : 0;
    onChange(next);
  };
  const add = () => {
    if (tiers.length >= SIBLING_TIERS_MAX) return;
    onChange([...tiers, tiers[tiers.length - 1] ?? 0]);
  };
  const remove = (idx: number) => {
    if (tiers.length <= 1) return;
    onChange(tiers.filter((_, i) => i !== idx));
  };
  const decreasing = tiers.some((t, i) => i > 0 && t < tiers[i - 1]);
  const example = [
    `1.º ${formatCurrency(BASE)}`,
    ...tiers.map((t, i) => {
      const label = i === tiers.length - 1 ? `${siblingOrdinal(i + 2)} en adelante` : siblingOrdinal(i + 2);
      return `${label} ${formatCurrency(Math.round(BASE * (1 - t / 100)))}`;
    }),
  ].join(' · ');

  return (
    <div className="space-y-2">
      <Label>Descuento por puesto del hijo</Label>
      <div className="space-y-2">
        {tiers.map((t, i) => {
          const isLast = i === tiers.length - 1;
          return (
            <div key={i} className="flex items-center gap-2" data-testid={`sibling-tier-row-${i}`}>
              <span className="text-sm w-40 shrink-0">
                {siblingOrdinal(i + 2)} hijo{isLast ? ' en adelante' : ''}
              </span>
              <Input
                type="number"
                inputMode="decimal"
                min={0}
                max={100}
                step={0.5}
                className="w-24 h-9"
                value={t}
                onChange={e => setAt(i, e.target.value)}
                data-testid={`sibling-tier-input-${i}`}
                aria-label={`Porcentaje de descuento del ${siblingOrdinal(i + 2)} hijo`}
              />
              <span className="text-sm text-muted-foreground">%</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 px-2 text-muted-foreground"
                disabled={tiers.length <= 1}
                onClick={() => remove(i)}
                data-testid={`sibling-tier-remove-${i}`}
                aria-label={`Quitar escalón del ${siblingOrdinal(i + 2)} hijo`}
              >
                <XCircle className="h-4 w-4" />
              </Button>
            </div>
          );
        })}
      </div>
      {tiers.length < SIBLING_TIERS_MAX && (
        <Button type="button" variant="outline" size="sm" onClick={add} data-testid="sibling-tier-add">
          + Agregar escalón
        </Button>
      )}
      {decreasing && (
        <p className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400" data-testid="sibling-tier-warning">
          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          Ojo: hay un escalón con menos descuento que el anterior. Se puede guardar así, pero revisa que sea lo que quieres.
        </p>
      )}
      <p className="text-xs text-muted-foreground" data-testid="sibling-tier-example">
        Ejemplo con mensualidad de {formatCurrency(BASE)}: {example}
      </p>
    </div>
  );
}
