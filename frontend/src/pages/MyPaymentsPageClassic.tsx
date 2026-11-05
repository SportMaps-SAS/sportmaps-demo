import { useState, useEffect, useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  CreditCard, CheckCircle2, XCircle, Clock, Calendar,
  Plus, Eye, Loader2, Info, AlertTriangle,
  Percent, Zap, User, FileText
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { PaymentCheckoutModal } from '@/components/payment/PaymentCheckoutModal';
import { isOneTimeCategory } from '@/lib/payment-accounts';
import { GlosaRespondModal } from '@/components/payment/GlosaRespondModal';
import { FailedAttemptChip } from '@/components/payment/FailedAttemptChip';
import { listMine as listMyGlosas, OPEN_GLOSA_STATUSES, REASON_LABELS, type Glosa } from '@/lib/api/glosas';
import { formatCurrency } from '@/lib/utils';
import { normalizeReceiptUrl } from '@/lib/normalizeReceiptUrl';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/integrations/supabase/client';
import { calcEarlyPaymentDiscount, modoProntoPago } from '@/lib/earlyPaymentDiscount';
import { MiFacturaElectronicaCard } from '@/components/billing/MiFacturaElectronicaCard';
import { DebitoAutomaticoCard, DebitoSugerenciaBanner } from '@/components/autopay/DebitoAutomaticoCard';
import { useMiDebito } from '@/components/autopay/useMiDebito';

interface Enrollment {
  id: string;
  child_id: string;
  team_id: string | null;
  school_id: string;
  children: {
    full_name: string;
  } | null;
  teams: {
    name: string;
    price_monthly: number;
  } | null;
  schools: {
    name: string;
    school_type?: string;
  } | null;
}

interface ViewingProof {
  open: boolean;
  url: string;
  concept: string;
  amount: number;
}

interface Transaction {
  id: string;
  amount: number;
  payment_method: string;
  status: string;
  reference: string;
  transaction_date: string;
  authorization_code?: string;
  receipt_url?: string;
  amount_paid?: number;
  balance_pending?: number;
  pct_paid?: number;
  installments_pending?: number;
  school_id?: string;
  school_type?: string;
  concept?: string;
  child_id?: string;
  child_name?: string;
  period_year?: number | null;
  period_month?: number | null;
  period_label?: string | null;
  late_fee_amount?: number | null;
  /** Descuento por hermanos (mig. 20260916101241) ya neteado en `amount` al
   *  generarse el cobro — a diferencia de discount_amount (pronto pago), este
   *  no cambia si se paga antes o después. Solo informativo. */
  sibling_discount_applied?: number | null;
  discount_amount?: number;
  discount_eligible?: boolean;
  discount_valid_until?: string | null;
  /** payments.payment_category (la vista payments_with_installments no la trae). */
  payment_category?: string | null;
  last_failure_reason?: string | null;
  last_failure_at?: string | null;
  requires_review?: boolean | null;
}

const MONTH_NAMES_ES = [
  'Enero','Febrero','Marzo','Abril','Mayo','Junio',
  'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'
];
const formatPeriodLabel = (year?: number | null, month?: number | null): string | null =>
  year && month && month >= 1 && month <= 12 ? `${MONTH_NAMES_ES[month - 1]} ${year}` : null;

const statusConfig: Record<string, { label: string; icon: any; color: string }> = {
  pending:           { label: 'Pendiente',   icon: Clock,       color: 'bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-400 dark:border-amber-800' },
  awaiting_approval: { label: 'Por Validar', icon: Loader2,     color: 'bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-900/30 dark:text-blue-400 dark:border-blue-800' },
  approved:          { label: 'Aprobado',   icon: CheckCircle2, color: 'bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-400 dark:border-emerald-800' },
  rejected:          { label: 'Rechazado',  icon: XCircle,     color: 'bg-red-100 text-red-700 border-red-200 dark:bg-red-900/30 dark:text-red-400 dark:border-red-800' },
  failed:            { label: 'Rechazado',  icon: XCircle,     color: 'bg-red-100 text-red-700 border-red-200 dark:bg-red-900/30 dark:text-red-400 dark:border-red-800' },
  cancelled:         { label: 'Anulado',    icon: XCircle,     color: 'bg-zinc-100 text-zinc-600 border-zinc-200 dark:bg-zinc-800/40 dark:text-zinc-400 dark:border-zinc-700' },
  partial:           { label: 'Abono Recibido', icon: Percent,  color: 'bg-indigo-100 text-indigo-700 border-indigo-200 dark:bg-indigo-900/30 dark:text-indigo-400 dark:border-indigo-800' },
  glosado:           { label: 'Necesita aclaración', icon: AlertTriangle, color: 'bg-orange-100 text-orange-700 border-orange-200 dark:bg-orange-900/30 dark:text-orange-400 dark:border-orange-800' },
};

// Estados que cuentan como "pendiente de pago" (dinero por cobrar). Los
// terminales negativos (rejected/failed/cancelled) NO son pendientes.
//
// OJO: no incluye 'overdue' — `payments.status` sí puede venir así (línea
// ~275, solo 'paid' se remapea a 'approved') y statusConfig cae a
// "Pendiente" para ese caso por el fallback `|| statusConfig.pending`. No
// agregar 'overdue' acá porque también gatea el descuento por pronto pago
// (otro feature, otro alcance); para el chip de intento fallido se usa
// TERMINAL_STATES_FOR_FAILURE_CHIP en su lugar, con la lista invertida.
const PENDING_STATES = ['pending', 'awaiting_approval', 'partial', 'glosado'];

// Estados donde un intento fallido previo ya no es relevante: el pago
// terminó (a favor o en contra) y mostrar "pago rechazado" encima sería
// engañoso o redundante. Todo lo demás (pending, overdue, partial,
// glosado, awaiting_approval, o cualquier estado futuro no listado) sí lo
// muestra — lista negra en vez de blanca para no repetir el bug de dejar
// 'overdue' afuera.
const TERMINAL_STATES_FOR_FAILURE_CHIP = ['approved', 'cancelled', 'rejected', 'failed'];

// Estados en los que el cobro tiene botón "Pagar" directo (y que el atajo
// `?pay=` del dashboard puede abrir solo).
const DIRECTLY_PAYABLE_STATES = ['pending', 'overdue', 'rejected', 'failed'];

export default function MyPaymentsPage() {
  const { user, profile } = useAuth();
  const { toast } = useToast();
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  // Glosas abiertas del acudiente, indexadas por payment_id (para el botón Responder).
  const [glosaMap, setGlosaMap] = useState<Map<string, Glosa>>(new Map());
  const [respondingGlosa, setRespondingGlosa] = useState<Glosa | null>(null);
  const [loading, setLoading] = useState(true);
  const [showCheckout, setShowCheckout] = useState(false);
  const [showChildPicker, setShowChildPicker] = useState(false);
  const [selectedPayment, setSelectedPayment] = useState<{
    childId: string;
    childName: string;
    teamId?: string;
    teamName: string;
    amount: number;
    schoolId: string;
    paymentId?: string;
    discount_eligible?: boolean;
    discount_amount?: number;
    paymentCategory?: string | null;
    /** Recargo por mora ya sumado en el cobro (apply_late_fees). Solo se muestra. */
    late_fee_amount?: number | null;
  } | null>(null);

  const [enrollments, setEnrollments] = useState<Enrollment[]>([]);

  // Débito automático (F3): si el BFF no responde, `debito.data` queda null y
  // la sección no se muestra (nunca rompe Mis Pagos).
  const debito = useMiDebito(!!user && profile?.role === 'parent');
  const [activarDebitoSchoolId, setActivarDebitoSchoolId] = useState<string | null>(null);

  // Atajo `?pay=<id>` o `?pay=auto` (banner del dashboard, correos, WhatsApp):
  // abre el modal de pago sin que el padre tenga que buscar el cobro y tocar
  // "Pagar". `auto` solo actúa cuando hay exactamente un cobro pagable; con
  // varios, se queda en la lista. El parámetro se limpia para que un refresh
  // no reabra el modal.
  const [searchParams, setSearchParams] = useSearchParams();
  const autoOpenedRef = useRef(false);

  const [viewingProof, setViewingProof] = useState<ViewingProof>({
    open: false,
    url: '',
    concept: '',
    amount: 0,
  });

  // Facturas electrónicas emitidas, mapeadas por payment_id (para mostrar el
  // botón "Factura" en los pagos que ya la tienen). La RLS deja al padre leer
  // la factura de su propio pago.
  const [invoiceMap, setInvoiceMap] = useState<Record<string, { number: string | null; public_url: string | null }>>({});

  useEffect(() => {
    if (user && profile) {
      if (profile.role !== 'parent') {
        window.location.href = profile.role === 'athlete' ? '/athlete-payments' : '/dashboard';
        return;
      }
      fetchPaymentData();
    }
  }, [user?.id, profile?.role]);

  const fetchPaymentData = async () => {
    try {
      setLoading(true);

      // ── PASO 1: Obtener hijos del padre ──────────────────────────────────
      const { data: childrenData, error: childrenError } = await supabase
        .from('children')
        .select(`
          id,
          full_name,
          monthly_fee,
          parent_id,
          school_id,
          team_id,
          teams:teams!children_team_id_fkey (
            name,
            price_monthly
          )
        `)
        .eq('parent_id', user?.id || '');

      if (childrenError) throw childrenError;

      const childIds = (childrenData || []).map((c: any) => c.id);

      // ── PASO 2: Pagos por parent_id O por child_id ────────────────────────
      let paymentsQuery = supabase
        .from('payments_with_installments' as any)
        .select('*')
        .order('created_at', { ascending: false });

      if (childIds.length > 0) {
        // Trae pagos donde soy el padre directamente O donde el child_id
        // pertenece a uno de mis hijos (pagos creados por admin sin parent_id)
        paymentsQuery = paymentsQuery.or(
          `parent_id.eq.${user?.id},child_id.in.(${childIds.join(',')})`
        );
      } else {
        // Sin hijos, solo pagos directos del padre
        paymentsQuery = paymentsQuery.eq('parent_id', user?.id || '');
      }

      const { data: payments, error: paymentsError } = await paymentsQuery;
      if (paymentsError) throw paymentsError;

      // ── PASO 2.5: Hidratar period_year/period_month desde la tabla base ──
      // La vista `payments_with_installments` no proyecta estas columnas
      // (creada antes de la migracion 20260503000004). Hacemos un select
      // directo a payments para obtenerlas por id. Si en el futuro la vista
      // se regenera incluyendo estos campos, esta query se vuelve redundante
      // pero no rompe nada (devuelve los mismos valores).
      const paymentIds = (payments || []).map((p: any) => p.id).filter(Boolean);
      let periodMap: Record<string, { period_year: number | null; period_month: number | null; late_fee_amount?: number | null; created_at: string; early_payment_discount_applied?: number | null; sibling_discount_applied?: number | null; child_id?: string | null; parent_id?: string | null; school_id: string; last_failure_reason?: string | null; last_failure_at?: string | null; requires_review?: boolean | null; payment_category?: string | null }> = {};
      if (paymentIds.length > 0) {
        const { data: periodRows } = await supabase
          .from('payments')
          .select('id, period_year, period_month, late_fee_amount, created_at, early_payment_discount_applied, sibling_discount_applied, child_id, parent_id, school_id, last_failure_reason, last_failure_at, requires_review, payment_category')
          .in('id', paymentIds);
        periodMap = Object.fromEntries(
          (periodRows || []).map((r: any) => [r.id, {
            period_year: r.period_year,
            period_month: r.period_month,
            late_fee_amount: r.late_fee_amount,
            created_at: r.created_at,
            early_payment_discount_applied: r.early_payment_discount_applied,
            sibling_discount_applied: r.sibling_discount_applied,
            child_id: r.child_id,
            parent_id: r.parent_id,
            school_id: r.school_id,
            last_failure_reason: r.last_failure_reason,
            last_failure_at: r.last_failure_at,
            requires_review: r.requires_review,
            payment_category: r.payment_category ?? null,
          }]),
        );
      }

      // ── PASO 3: Enriquecer con school_type ───────────────────────────────
      const transactionSchoolIds = [...new Set((payments || []).map((p: any) => p.school_id).filter(Boolean))];
      let schoolTypeMap: Record<string, string> = {};
      let discountConfigMap: Record<string, { enabled: boolean; days: number; percentage: number; mode?: 'days_from_creation' | 'day_of_month' }> = {};

      if (transactionSchoolIds.length > 0) {
        const { data: schoolsData } = await supabase
          .from('schools')
          .select('id, school_type')
          .in('id', transactionSchoolIds);
        schoolTypeMap = Object.fromEntries((schoolsData || []).map(s => [s.id, s.school_type]));

        const { data: settingsRows } = await supabase
          .from('school_settings')
          .select('school_id, early_payment_discount_enabled, early_payment_discount_days, early_payment_discount_percentage, early_payment_discount_mode')
          .in('school_id', transactionSchoolIds);
        discountConfigMap = Object.fromEntries((settingsRows || []).map((s: any) => [s.school_id, {
          enabled: !!s.early_payment_discount_enabled,
          days: s.early_payment_discount_days || 5,
          percentage: s.early_payment_discount_percentage || 0,
          mode: modoProntoPago(s.early_payment_discount_mode),
        }]));
      }

      const childNameMap = Object.fromEntries((childrenData || []).map(c => [c.id, c.full_name]));

      const unpaidGroups = new Map<string, string[]>();
      (payments || []).forEach((p: any) => {
        if (['pending', 'overdue', 'partial'].includes(p.status)) {
          const key = `${p.school_id}|${p.child_id ?? p.parent_id}`;
          if (!unpaidGroups.has(key)) unpaidGroups.set(key, []);
          unpaidGroups.get(key)!.push(p.created_at);
        }
      });
      const hasEarlierUnpaidFor = (schoolId: string, childId: string | null, parentId: string | null, createdAt: string) => {
        const key = `${schoolId}|${childId ?? parentId}`;
        return (unpaidGroups.get(key) || []).some(d => d < createdAt);
      };

      const txns: Transaction[] = (payments || []).map((p: any) => {
        const created_at = periodMap[p.id]?.created_at ?? p.created_at;
        const paymentCategory = periodMap[p.id]?.payment_category ?? null;
        // Pronto pago = solo mensualidad: a un cobro único (inscripción, seguro…)
        // no se le muestra descuento (el modal tampoco se lo aplica).
        const discountCfg = isOneTimeCategory(paymentCategory)
          ? { enabled: false, days: 5, percentage: 0 }
          : discountConfigMap[p.school_id] ?? { enabled: false, days: 5, percentage: 0 };
        const earlierUnpaid = hasEarlierUnpaidFor(p.school_id, p.child_id, p.parent_id, created_at);
        const discount = calcEarlyPaymentDiscount(p.amount, {
          createdAt: created_at,
          config: discountCfg,
          hasEarlierUnpaid: earlierUnpaid,
          alreadyAppliedAmount: periodMap[p.id]?.early_payment_discount_applied ?? null,
        });

        return {
          id: p.id,
          school_id: p.school_id,
          school_type: schoolTypeMap[p.school_id] || 'academy',
          amount: p.amount,
          amount_paid: p.amount_paid,
          balance_pending: p.balance_pending,
          pct_paid: p.pct_paid,
          installments_pending: p.installments_pending,
          concept: p.concept,
          child_id: p.child_id,
          // Acudiente que además es atleta: sus cobros propios llegan con él como
          // pagador y sin hijo (child_id NULL). Se muestran junto a los de los
          // hijos, rotulados como suyos (spec cambio-de-rol-atleta-acudiente.md).
          child_name: p.child_id
            ? (childNameMap[p.child_id] || 'Deportista')
            : (p.parent_id === user?.id ? 'Tú (como atleta)' : 'Deportista'),
          payment_method: p.payment_type || 'transfer',
          status: p.status === 'paid' ? 'approved' : p.status,
          reference: p.receipt_number || `SP-${p.id.slice(0, 8).toUpperCase()}`,
          transaction_date: p.payment_date || p.created_at,
          authorization_code: p.status === 'paid' ? `AUTH-${p.id.slice(0, 5).toUpperCase()}` : undefined,
          receipt_url: p.receipt_url,
          period_year:  periodMap[p.id]?.period_year ?? p.period_year ?? null,
          period_month: periodMap[p.id]?.period_month ?? p.period_month ?? null,
          period_label: formatPeriodLabel(
            periodMap[p.id]?.period_year ?? p.period_year,
            periodMap[p.id]?.period_month ?? p.period_month,
          ),
          late_fee_amount: periodMap[p.id]?.late_fee_amount ?? p.late_fee_amount ?? null,
          sibling_discount_applied: periodMap[p.id]?.sibling_discount_applied ?? p.sibling_discount_applied ?? null,
          discount_amount: discount.discountAmount,
          discount_eligible: discount.eligible,
          discount_valid_until: discount.validUntil,
          last_failure_reason: periodMap[p.id]?.last_failure_reason ?? null,
          last_failure_at: periodMap[p.id]?.last_failure_at ?? null,
          requires_review: periodMap[p.id]?.requires_review ?? null,
          payment_category: paymentCategory,
        };
      });
      setTransactions(txns);

      // ── PASO 3.4: Glosas abiertas del acudiente (para "Necesita aclaración") ──
      try {
        const glosas = await listMyGlosas();
        const m = new Map<string, Glosa>();
        for (const g of glosas) {
          if (OPEN_GLOSA_STATUSES.includes(g.status)) m.set(g.payment_id, g);
        }
        setGlosaMap(m);
      } catch {
        // Si el BFF no responde, no rompemos la vista de pagos.
        setGlosaMap(new Map());
      }

      // ── PASO 3.5: Facturas electrónicas emitidas por pago ─────────────────
      if (paymentIds.length > 0) {
        const { data: invRows } = await supabase
          .from('electronic_invoices')
          .select('payment_id, number, public_url, status')
          .in('payment_id', paymentIds)
          .in('status', ['accepted', 'sent']);
        setInvoiceMap(
          Object.fromEntries(
            (invRows || [])
              .filter((r: any) => r.payment_id)
              .map((r: any) => [r.payment_id, { number: r.number, public_url: r.public_url }]),
          ),
        );
      }

      // ── PASO 4: Enrollments (usando childrenData ya cargado) ──────────────
      if (childrenData && childrenData.length > 0) {
        const { data: enrollData, error: enrollError } = await supabase
          .from('enrollments')
          .select(`
            id,
            child_id,
            team_id,
            offering_plan_id,
            monthly_fee,
            school_id,
            status,
            team:teams!enrollments_team_id_fkey (
              name,
              price_monthly
            ),
            offering_plans!offering_plan_id (
              name,
              price,
              offerings!offering_id ( name )
            ),
            schools (
              name,
              school_type
            )
          `)
          .in('child_id', childIds)
          .eq('status', 'active');

        const enrollsByChild: Record<string, any[]> = {};
        if (!enrollError && enrollData) {
          enrollData.forEach((e: any) => {
            if (!enrollsByChild[e.child_id]) enrollsByChild[e.child_id] = [];
            enrollsByChild[e.child_id].push(e);
          });
        }

        const flattened: Enrollment[] = [];
        childrenData.forEach((child: any) => {
          const activeEnrollments = enrollsByChild[child.id] || [];

          if (activeEnrollments.length > 0) {
            // Líneas de este hijo: si el atleta tiene plan + equipo, el equipo es
            // roster (cuota 0) y NO debe aparecer como un cobro aparte — el
            // acudiente veía equipo + plan y parecía doble cobro.
            const childLines: Enrollment[] = [];
            activeEnrollments.forEach((enroll: any) => {
              const team = Array.isArray(enroll.team) ? enroll.team[0] : enroll.team;
              const plan = Array.isArray(enroll.offering_plans) ? enroll.offering_plans[0] : enroll.offering_plans;
              const offering = plan ? (Array.isArray(plan.offerings) ? plan.offerings[0] : plan.offerings) : null;
              // La cuota individual (enrollments.monthly_fee, editable por escuela/PT)
              // manda sobre el precio de catálogo del equipo/plan.
              const catalogPrice = team?.price_monthly ?? plan?.price ?? 0;
              const resolvedFee = enroll.monthly_fee ?? catalogPrice;
              const lineName = team?.name
                ?? (plan ? (offering?.name ? `${offering.name} — ${plan.name}` : plan.name) : 'Mensualidad Deportista');
              childLines.push({
                id: enroll.id,
                child_id: child.id,
                team_id: enroll.team_id || null,
                school_id: enroll.school_id,
                children: { full_name: child.full_name },
                teams: { name: lineName, price_monthly: resolvedFee },
                schools: enroll.schools,
              });
            });
            const withFee = childLines.filter(l => Number(l.teams?.price_monthly) > 0);
            flattened.push(...(withFee.length > 0 ? withFee : childLines));
          }
          else if (child.teams) {
            const directTeam = Array.isArray(child.teams) ? child.teams[0] : (child.teams as any);
            flattened.push({
              id: `direct-team-${child.id}`,
              child_id: child.id,
              team_id: child.team_id,
              school_id: child.school_id || '',
              children: { full_name: child.full_name },
              teams: {
                name: directTeam?.name,
                // cuota individual del atleta por encima del precio del equipo
                price_monthly: child.monthly_fee || directTeam?.price_monthly || 0,
              },
              schools: null,
            });
          }
          else if (child.monthly_fee > 0) {
            flattened.push({
              id: `child-${child.id}`,
              child_id: child.id,
              team_id: child.team_id || null,
              school_id: child.school_id || '',
              children: { full_name: child.full_name },
              teams: {
                name: 'Mensualidad Deportista',
                price_monthly: child.monthly_fee,
              },
              schools: null,
            });
          }
          else {
            flattened.push({
              id: `empty-${child.id}`,
              child_id: child.id,
              team_id: null,
              school_id: child.school_id || '',
              children: { full_name: child.full_name },
              teams: {
                name: 'Sin programa asignado',
                price_monthly: 0,
              },
              schools: null,
            });
          }
        });
        setEnrollments(flattened);
      } else {
        setEnrollments([]);
      }
    } catch (error) {
      console.error('Error fetching payment data:', error);
    } finally {
      setLoading(false);
    }
  };

  // Lo que el modal de pago necesita de una fila, armado en un solo lugar.
  const toSelectedPayment = (p: Transaction) => ({
    childId: p.child_id || '',
    childName: p.child_name || 'Deportista',
    teamName: p.concept || 'Mensualidad',
    amount: p.balance_pending || p.amount,
    schoolId: p.school_id || '',
    paymentId: p.id,
    discount_eligible: p.discount_eligible,
    discount_amount: p.discount_amount,
    paymentCategory: p.payment_category ?? null,
    late_fee_amount: p.late_fee_amount ?? null,
  });

  useEffect(() => {
    if (loading || autoOpenedRef.current) return;
    const pay = searchParams.get('pay');
    if (!pay) return;
    autoOpenedRef.current = true;
    const payable = transactions.filter(t => DIRECTLY_PAYABLE_STATES.includes(t.status));
    const target = pay === 'auto'
      ? (payable.length === 1 ? payable[0] : null)
      : (payable.find(t => t.id === pay) ?? null);
    setSearchParams(prev => { prev.delete('pay'); return prev; }, { replace: true });
    if (!target) return;
    setSelectedPayment(toSelectedPayment(target));
    setShowCheckout(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- corre una sola vez, al terminar la carga
  }, [loading, transactions, searchParams]);

  const handleShowProof = async (receiptUrl: string, concept: string, amount: number) => {
    if (!receiptUrl) return;

    // ✅ Short-circuit si ya es URL pública directa
    if (receiptUrl.startsWith('http')) {
      setViewingProof({ open: true, url: receiptUrl, concept, amount });
      return;
    }

    try {
      const cleanPath = normalizeReceiptUrl(receiptUrl);
      const { data, error } = await supabase.storage
        .from('payment-receipts')
        .createSignedUrl(cleanPath, 300);

      if (error) throw error;

      setViewingProof({
        open: true,
        url: data.signedUrl,
        concept,
        amount,
      });
    } catch (err: unknown) {
      console.error('Error generating signed URL:', err);
      toast({
        title: 'Error de acceso',
        description: 'No se pudo generar el acceso seguro al comprobante.',
        variant: 'destructive',
      });
    }
  };

  const summary = {
    count_pending: transactions.filter(t => PENDING_STATES.includes(t.status)).length,
    count_approved: transactions.filter(t => t.status === 'approved').length,
    pending_total: transactions.filter(t => PENDING_STATES.includes(t.status)).reduce((sum, t) => sum + (t.balance_pending || t.amount), 0),
    count_total: transactions.length
  };

  const renderPaymentList = (list: Transaction[]) => {
    if (list.length === 0) return (
      <Card className="border-dashed">
        <CardContent className="p-8 text-center">
          <CreditCard className="h-10 w-10 mx-auto mb-3 text-muted-foreground opacity-30" />
          <h3 className="font-semibold text-lg">Sin movimientos</h3>
          <p className="text-muted-foreground mt-1">No hay registros en esta sección.</p>
        </CardContent>
      </Card>
    );

    return list.map(txn => (
      <PaymentCard
        key={txn.id}
        txn={txn}
        invoice={invoiceMap[txn.id]}
        openGlosa={glosaMap.get(txn.id) || null}
        onRespondGlosa={(g) => setRespondingGlosa(g)}
        onSelect={(p) => {
          if (p.status === 'approved' || p.status === 'glosado') return;
          setSelectedPayment(prev => prev?.paymentId === p.id ? null : {
            childId: p.child_id || '',
            childName: p.child_name || 'Deportista',
            teamName: p.concept || 'Mensualidad',
            amount: p.balance_pending || p.amount,
            schoolId: p.school_id || '',
            paymentId: p.id,
            discount_eligible: p.discount_eligible,
            discount_amount: p.discount_amount,
            paymentCategory: p.payment_category ?? null,
            late_fee_amount: p.late_fee_amount ?? null,
          });
        }}
        isSelected={selectedPayment?.paymentId === txn.id}
        onShowProof={handleShowProof}
        onAbonar={(p) => {
          // Abonar reusa el flujo probado: subir comprobante por el saldo →
          // queda awaiting_approval → la escuela lo registra como abono (suma a
          // amount_paid). El flujo viejo de payment_installments quedó huérfano
          // (la escuela no lo revisaba).
          setSelectedPayment(toSelectedPayment(p));
          setShowCheckout(true);
        }}
        onPay={(p) => {
          // Botón "Pagar" directo: selecciona y abre el modal en un solo
          // click, sin pasar por la barra flotante (antes eran 2 clicks).
          setSelectedPayment(toSelectedPayment(p));
          setShowCheckout(true);
        }}
      />
    ));
  };

  if (loading && transactions.length === 0) {
    return (
      <div className="flex items-center justify-center h-[60dvh]">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="space-y-6 pb-24 relative">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight flex items-center gap-3 truncate">
            <CreditCard className="h-7 w-7 text-primary" />
            Mis Pagos
          </h1>
          <p className="text-sm md:text-base text-muted-foreground truncate">Tus mensualidades, pagos y débito automático</p>
        </div>
        <Button onClick={() => setShowChildPicker(true)} size="sm" className="w-full md:w-auto">
          <Plus className="h-4 w-4 mr-2" />
          Nuevo Pago
        </Button>
      </div>

      {/* Invitación a activar el débito desde donde la familia ya paga. */}
      <DebitoSugerenciaBanner data={debito.data} userId={user?.id} onActivar={setActivarDebitoSchoolId} />

      {/* Estado de Cuenta por hijo — misma pantalla que usa la escuela
          (get_athlete_account_statement), acotada a lo suyo por el gate de la
          RPC (children.parent_id = auth.uid()). Esta página es solo de
          `parent` (el useEffect de arriba redirige a cualquier otro rol antes
          de llegar acá), así que el bloque "Mi estado de cuenta" del atleta
          adulto nunca podía renderizar — vive ahora en AthletePaymentsPage. */}
      {enrollments.some(e => e.child_id) && (
        <div className="flex flex-wrap gap-2">
          {[...new Map(enrollments.filter(e => e.child_id).map(e => [e.child_id, e])).values()].map((e) => (
            <Button key={e.child_id} asChild variant="outline" size="sm">
              <Link to={`/estado-cuenta?child_id=${e.child_id}`}>
                <FileText className="h-3.5 w-3.5 mr-2" />
                Estado de cuenta — {e.children?.full_name || 'mi hijo/a'}
              </Link>
            </Button>
          ))}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <Card className="hover:shadow-md transition-shadow">
          <CardContent className="p-4 flex items-center gap-4">
            <div className="h-12 w-12 rounded-xl bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center">
              <Clock className="h-6 w-6 text-amber-600 dark:text-amber-400" />
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Pendientes</p>
              <p className="text-xl font-bold text-foreground">{summary.count_pending}</p>
            </div>
          </CardContent>
        </Card>

        <Card className="hover:shadow-md transition-shadow">
          <CardContent className="p-4 flex items-center gap-4">
            <div className="h-12 w-12 rounded-xl bg-amber-50 dark:bg-amber-900/20 flex items-center justify-center">
              <CreditCard className="h-6 w-6 text-amber-500 dark:text-amber-400" />
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Monto pendiente</p>
              <p className="text-xl font-bold text-foreground">{formatCurrency(summary.pending_total)}</p>
            </div>
          </CardContent>
        </Card>

        <Card className="hover:shadow-md transition-shadow">
          <CardContent className="p-4 flex items-center gap-4">
            <div className="h-12 w-12 rounded-xl bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center">
              <CheckCircle2 className="h-6 w-6 text-emerald-600 dark:text-emerald-400" />
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Pagos realizados</p>
              <p className="text-xl font-bold text-foreground">{summary.count_approved}</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Débito automático (F3). Reemplaza la tarjeta falsa de "Suscripciones
          Activas". Los avisos enlazan a /my-payments#debito. */}
      <div id="debito" className="scroll-mt-20">
        <DebitoAutomaticoCard
          data={debito.data}
          reload={debito.reload}
          activarSchoolId={activarDebitoSchoolId}
          onActivarSchoolIdChange={setActivarDebitoSchoolId}
        />
      </div>

      {/* ¿Quiere factura electrónica a su nombre? Mismo bloque que /p/:token. */}
      <MiFacturaElectronicaCard />

      <Tabs defaultValue="all" className="space-y-4">
        <TabsList>
          <TabsTrigger value="all">Todas ({summary.count_total})</TabsTrigger>
          <TabsTrigger value="approved">Aprobadas ({summary.count_approved})</TabsTrigger>
          <TabsTrigger value="pending">Pendientes ({summary.count_pending})</TabsTrigger>
        </TabsList>

        <TabsContent value="all" className="space-y-4">
          {renderPaymentList(transactions)}
        </TabsContent>

        <TabsContent value="approved" className="space-y-4">
          {renderPaymentList(transactions.filter(t => t.status === 'approved'))}
        </TabsContent>

        <TabsContent value="pending" className="space-y-4">
          {renderPaymentList(transactions.filter(t => PENDING_STATES.includes(t.status)))}
        </TabsContent>
      </Tabs>

      {/* Child Picker Dialog */}
      <Dialog open={showChildPicker} onOpenChange={setShowChildPicker}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>¿Para quién es el pago?</DialogTitle>
            <DialogDescription>
              Selecciona el hijo/a al que deseas realizarle el pago de mensualidad.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            {enrollments.length > 0 ? (
              enrollments.map((enroll) => {
                const isPT = enroll.schools?.school_type === 'personal_trainer';
                return (
                  <button
                    key={enroll.id}
                    className={`w-full flex items-center justify-between p-4 border rounded-xl transition-all text-left shadow-sm
                      ${isPT 
                        ? 'bg-zinc-900 border-zinc-800 hover:border-indigo-500/50 hover:bg-zinc-950 dark:bg-zinc-950 dark:hover:bg-black' 
                        : 'bg-background hover:bg-muted/50 hover:border-primary'}`}
                    onClick={() => {
                      setSelectedPayment({
                        childId: enroll.child_id,
                        childName: enroll.children?.full_name || 'Deportista',
                        teamId: enroll.team_id || undefined,
                        teamName: enroll.teams?.name || 'Mensualidad Deportista',
                        amount: enroll.teams?.price_monthly || 0,
                        schoolId: enroll.school_id,
                      });
                      setShowChildPicker(false);
                      setShowCheckout(true);
                    }}
                  >
                    <div className="flex items-center gap-3">
                      <div className={`w-10 h-10 rounded-full flex items-center justify-center text-white font-semibold shadow-sm
                        ${isPT 
                          ? 'bg-gradient-to-br from-indigo-500 to-indigo-700 shadow-indigo-500/20' 
                          : 'bg-gradient-to-br from-primary to-primary/60'}`}>
                        {isPT ? <User className="h-5 w-5" /> : (enroll.children?.full_name || 'E').charAt(0)}
                      </div>
                      <div className="min-w-0">
                        <p className={`font-semibold truncate ${isPT ? 'text-zinc-100' : ''}`}>{enroll.children?.full_name}</p>
                        <p className={`text-xs truncate ${isPT ? 'text-indigo-400 font-bold uppercase tracking-wider flex items-center gap-1' : 'text-muted-foreground'}`}>
                          {isPT && <Zap className="h-3 w-3" />}
                          {isPT ? 'Coach Personal' : (enroll.teams?.name || 'Sin curso asignado')}
                        </p>
                        {enroll.schools?.name && (
                          <p className={`text-[10px] italic truncate ${isPT ? 'text-zinc-500' : 'text-muted-foreground'}`}>
                            {isPT ? `Con ${enroll.schools.name}` : `Escuela: ${enroll.schools.name}`}
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="text-right ml-2 shrink-0">
                      <p className={`font-bold ${isPT ? 'text-indigo-400' : 'text-primary'}`}>{formatCurrency(enroll.teams?.price_monthly || 0)}</p>
                      <p className={`text-xs ${isPT ? 'text-zinc-500' : 'text-muted-foreground'}`}>/mes</p>
                    </div>
                  </button>
                );
              })
            ) : (
              <div className="text-center py-8">
                <p className="text-muted-foreground">No tienes hijos registrados.</p>
                <Button variant="link" asChild className="mt-2 text-primary p-0">
                  <a href="/children">Ir a Mis Hijos para registrarlos</a>
                </Button>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Payment Checkout Modal */}
      {selectedPayment && (
        <PaymentCheckoutModal
          open={showCheckout}
          onOpenChange={setShowCheckout}
          studentId={selectedPayment.childId}
          childId={selectedPayment.childId}
          // Sin esto la notificación al colegio sale como "un deportista envió
          // comprobante": el modal cae en su genérico cuando no le llega el nombre.
          childName={selectedPayment.childName}
          teamId={selectedPayment.teamId}
          schoolId={selectedPayment.schoolId}
          paymentId={selectedPayment.paymentId}
          amount={selectedPayment.amount}
          concept={selectedPayment.teamName}
          paymentCategory={selectedPayment.paymentCategory ?? null}
          mode={selectedPayment.paymentId ? 'update' : 'create'}
          onSuccess={fetchPaymentData}
        />
      )}

      {/* Responder glosa (aclaración) */}
      <GlosaRespondModal
        glosa={respondingGlosa}
        open={!!respondingGlosa}
        onOpenChange={(o) => { if (!o) setRespondingGlosa(null); }}
        onSuccess={fetchPaymentData}
      />

      {/* Barra de acción flotante (estilo atleta). Offset inferior mayor que
          bottom-6 en móvil: MobileBottomNav (h-16 + safe-area, ver
          components/navigation/MobileBottomNav.tsx) vive fijo en el mismo
          borde y esta barra, con z-index mayor, quedaba encima tapándolo. */}
      {selectedPayment && (
        <div className="fixed bottom-[calc(4rem+env(safe-area-inset-bottom)+0.75rem)] md:bottom-6 left-1/2 -translate-x-1/2 w-[calc(100%-2rem)] max-w-2xl bg-zinc-900 dark:bg-zinc-950 border border-zinc-800 dark:border-zinc-800 text-white p-4 rounded-xl shadow-2xl flex items-center justify-between z-50 animate-in fade-in slide-in-from-bottom-5 duration-300">
          <div className="flex flex-col min-w-0">
            <span className="text-zinc-500 dark:text-zinc-400 text-[10px] uppercase tracking-wider font-bold truncate">
              {selectedPayment.childName} — {selectedPayment.teamName}
            </span>
            {selectedPayment.discount_eligible && (selectedPayment.discount_amount ?? 0) > 0 ? (
              <div className="flex items-baseline gap-1.5 animate-in fade-in">
                <span className="text-xs text-zinc-500 line-through font-normal">
                  {formatCurrency(selectedPayment.amount)}
                </span>
                <span className="font-bold text-xl text-emerald-400 dark:text-emerald-300">
                  {formatCurrency(selectedPayment.amount - selectedPayment.discount_amount!)}
                </span>
              </div>
            ) : (
              <span className="font-bold text-xl text-emerald-400 dark:text-emerald-300">
                {formatCurrency(selectedPayment.amount)}
              </span>
            )}
            {(selectedPayment.late_fee_amount ?? 0) > 0 && (
              <span className="text-[10px] font-semibold text-amber-400 dark:text-amber-300">
                Incluye recargo por mora: {formatCurrency(selectedPayment.late_fee_amount as number)}
              </span>
            )}
          </div>
          
          <div className="flex items-center gap-3">
            <Button 
              variant="ghost" 
              className="text-zinc-400 hover:text-white hover:bg-zinc-800 dark:hover:bg-zinc-900 hidden sm:flex"
              onClick={() => setSelectedPayment(null)}
            >
              Cancelar
            </Button>
            <Button 
              className="bg-emerald-600 hover:bg-emerald-700 text-white px-8 font-bold shadow-lg shadow-emerald-600/20"
              onClick={() => setShowCheckout(true)}
            >
              Pagar Ahora
            </Button>
          </div>
        </div>
      )}

      {/* Proof Viewer Dialog for Parents */}
      <Dialog open={viewingProof.open} onOpenChange={(open) => setViewingProof(prev => ({ ...prev, open }))}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Mi Comprobante</DialogTitle>
            <DialogDescription>
              {viewingProof.concept}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="bg-muted p-3 rounded-lg flex justify-between items-center">
              <span className="font-semibold text-sm truncate mr-2">{viewingProof.concept}</span>
              <span className="font-bold text-lg shrink-0">
                {formatCurrency(viewingProof.amount)}
              </span>
            </div>
            <div className="border rounded-md overflow-hidden bg-muted/30 min-h-48 flex items-center justify-center">
              {viewingProof.url ? (
                <img
                  src={viewingProof.url}
                  alt="Comprobante"
                  className="max-w-full max-h-list object-contain"
                />
              ) : (
                <div className="text-center text-muted-foreground p-8">
                  <Loader2 className="h-8 w-8 animate-spin mx-auto mb-2" />
                  <p>Cargando comprobante...</p>
                </div>
              )}
            </div>
            <div className="flex justify-end gap-2 text-primary">
              <Button variant="secondary" onClick={() => setViewingProof(prev => ({ ...prev, open: false }))}>
                Cerrar
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function PaymentCard({ txn, onSelect, isSelected, onShowProof, onAbonar, onPay, invoice, openGlosa, onRespondGlosa }: {
  txn: Transaction;
  onSelect: (p: Transaction) => void;
  isSelected: boolean;
  onShowProof: (url: string, concept: string, amount: number) => void;
  onAbonar: (p: Transaction) => void;
  onPay: (p: Transaction) => void;
  invoice?: { number: string | null; public_url: string | null };
  openGlosa?: Glosa | null;
  onRespondGlosa?: (g: Glosa) => void;
}) {
  const config = statusConfig[txn.status] || statusConfig.pending;
  const StatusIcon = config.icon;
  const nonInteractive = txn.status === 'approved' || txn.status === 'glosado';
  // Estados que necesitan un pago nuevo (no un abono ni una aclaración):
  // el botón "Pagar" les ahorra el paso de seleccionar + usar la barra flotante.
  const payableDirectly = DIRECTLY_PAYABLE_STATES.includes(txn.status);

  return (
    <Card
      className={`transition-all overflow-hidden ${nonInteractive ? 'cursor-default' : 'cursor-pointer hover:border-primary/30'} ${
        isSelected
          ? 'border-primary bg-primary/5 shadow-md ring-1 ring-primary/20'
          : 'border-border'
      }`}
      onClick={() => onSelect(txn)}
    >
      <CardContent className="p-4 sm:p-5">
        <div className="flex items-start gap-3">
          <div className={`h-10 w-10 sm:h-12 sm:w-12 rounded-xl flex items-center justify-center shrink-0 ${config.color.split(' ')[0]}`}>
            <StatusIcon className={`h-5 w-5 sm:h-6 sm:w-6 ${config.color.split(' ')[1]}`} />
          </div>

          <div className="flex-1 min-w-0 space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-bold text-muted-foreground uppercase tracking-wide">
                {txn.child_name || 'Deportista'}
              </span>
              {txn.school_type === 'personal_trainer' && (
                <Badge variant="outline" className="text-[10px] py-0 px-2 h-5 bg-indigo-50 border-indigo-200 text-indigo-700 dark:bg-indigo-900/30 dark:border-indigo-800 dark:text-indigo-400 font-bold">
                  <Zap className="h-2.5 w-2.5 mr-1 fill-indigo-500/20" />
                  ENTRENADOR PT
                </Badge>
              )}
            </div>

            <div className="flex items-center justify-between gap-2">
              <h3 className="font-bold text-sm sm:text-base text-foreground truncate">
                {/* El trigger fn_payments_fill_period rellena period_year/period_month
                    en CUALQUIER pago (torneos, tienda, mensualidad — no solo mensualidad),
                    así que su sola presencia no indica que el pago sea una mensualidad.
                    concept siempre viene poblado (0 nulos verificado en producción) y ya
                    incluye "Mensualidad {mes}" cuando corresponde — mostrarlo directo evita
                    que un pago de torneo/tienda aparezca disfrazado de mensualidad. */}
                {txn.concept || (txn.period_label ? `Mensualidad ${txn.period_label}` : 'Mensualidad')}
              </h3>
              <div className="text-right shrink-0">
                {txn.discount_eligible && (txn.discount_amount ?? 0) > 0 && PENDING_STATES.includes(txn.status) ? (
                  <div className="flex items-center gap-1.5 justify-end">
                    <span className="text-xs text-muted-foreground line-through font-normal">
                      {formatCurrency(txn.amount)}
                    </span>
                    <span className="font-bold text-sm sm:text-base text-primary">
                      {formatCurrency(txn.amount - txn.discount_amount!)}
                    </span>
                  </div>
                ) : (
                  <p className="font-bold text-sm sm:text-base text-foreground">
                    {formatCurrency(txn.amount)}
                  </p>
                )}
                {txn.status === 'partial' && (
                  <p className="text-[10px] text-red-500 dark:text-red-400 font-bold">
                    PENDIENTE: {formatCurrency(txn.balance_pending || 0)}
                  </p>
                )}
                {(txn.late_fee_amount ?? 0) > 0 && (
                  <p className="text-[10px] text-amber-600 dark:text-amber-400 font-semibold">
                    Incluye recargo por mora: {formatCurrency(txn.late_fee_amount as number)}
                  </p>
                )}
                {(txn.sibling_discount_applied ?? 0) > 0 && (
                  <p className="text-[10px] text-emerald-600 dark:text-emerald-400 font-semibold">
                    Incluye descuento por hermanos: {formatCurrency(txn.sibling_discount_applied as number)}
                  </p>
                )}
                {txn.discount_eligible && (txn.discount_amount ?? 0) > 0 && PENDING_STATES.includes(txn.status) && (
                  <p className="text-[10px] text-emerald-600 dark:text-emerald-400 font-semibold">
                    Ahorra {formatCurrency(txn.discount_amount!)} pagando antes del {txn.discount_valid_until}
                  </p>
                )}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground pt-1">
              <div className="flex items-center gap-1">
                <Calendar className="h-3.5 w-3.5" />
                {new Date(txn.transaction_date).toLocaleDateString('es-CO', { day: '2-digit', month: 'short', year: 'numeric' })}
              </div>
              <div className="flex items-center gap-1">
                <Info className="h-3.5 w-3.5" />
                REF: <span className="font-mono">{txn.reference}</span>
              </div>
            </div>

            {!TERMINAL_STATES_FOR_FAILURE_CHIP.includes(txn.status) && (
              <div className="mt-1">
                <FailedAttemptChip
                  reason={txn.last_failure_reason}
                  at={txn.last_failure_at}
                  requiresReview={txn.requires_review}
                  showReason
                />
              </div>
            )}

            {txn.status === 'glosado' && (
              <div className="mt-2 rounded-md border border-orange-300 bg-orange-50 dark:bg-orange-950/30 p-2 text-xs text-orange-800 dark:text-orange-300">
                <p className="font-semibold flex items-center gap-1">
                  <AlertTriangle className="h-3 w-3 shrink-0" />
                  {openGlosa ? REASON_LABELS[openGlosa.reason] : 'Tu comprobante necesita una aclaración.'}
                </p>
                {openGlosa?.responds_by && (
                  <p className="mt-0.5">
                    Responde antes del{' '}
                    <strong>
                      {new Date(openGlosa.responds_by + 'T00:00:00').toLocaleDateString('es-CO', { day: '2-digit', month: 'short', year: 'numeric' })}
                    </strong>.
                  </p>
                )}
              </div>
            )}

            <div className="flex items-center justify-between pt-3 border-t mt-3 sm:mt-4">
              <Badge variant="outline" className={`h-6 text-[10px] font-bold ${config.color}`}>
                <StatusIcon className="h-3 w-3 mr-1" />
                {config.label.toUpperCase()}
              </Badge>

              <div className="flex items-center gap-2">
                {invoice?.public_url && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 text-[11px] font-bold text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50"
                    title={invoice.number ? `Factura ${invoice.number}` : 'Factura electrónica'}
                    onClick={(e) => {
                      e.stopPropagation();
                      window.open(invoice.public_url!, '_blank', 'noopener,noreferrer');
                    }}
                  >
                    <FileText className="h-3.5 w-3.5 mr-1" />
                    FACTURA
                  </Button>
                )}
                {txn.receipt_url && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 text-[11px] font-bold text-blue-600 hover:text-blue-700 hover:bg-blue-50"
                    onClick={(e) => {
                      e.stopPropagation();
                      onShowProof(txn.receipt_url!, txn.concept || '', txn.amount);
                    }}
                  >
                    <Eye className="h-3.5 w-3.5 mr-1" />
                    RECIBO
                  </Button>
                )}
                {txn.status === 'partial' && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 text-[11px] font-bold text-primary hover:text-primary hover:bg-primary/10"
                    onClick={(e) => {
                      e.stopPropagation();
                      onAbonar(txn);
                    }}
                  >
                    <Plus className="h-3.5 w-3.5 mr-1" />
                    ABONAR
                  </Button>
                )}
                {payableDirectly && (
                  <Button
                    size="sm"
                    className="h-8 text-[11px] font-bold bg-emerald-600 hover:bg-emerald-700 text-white"
                    onClick={(e) => {
                      e.stopPropagation();
                      onPay(txn);
                    }}
                  >
                    <CreditCard className="h-3.5 w-3.5 mr-1" />
                    PAGAR
                  </Button>
                )}
                {txn.status === 'glosado' && openGlosa && onRespondGlosa && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 text-[11px] font-bold text-orange-600 hover:text-orange-700 hover:bg-orange-50"
                    onClick={(e) => {
                      e.stopPropagation();
                      onRespondGlosa(openGlosa);
                    }}
                  >
                    <AlertTriangle className="h-3.5 w-3.5 mr-1" />
                    RESPONDER
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}