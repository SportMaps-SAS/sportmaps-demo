/**
 * /my-payments — Pagos del acudiente (rol `parent`), rediseño V2.
 *
 * La vista es AcuPagosV2 (Por pagar · Pagados). Esta página conserva todo lo
 * que no es presentación: la carga de datos (con su historia: pronto pago,
 * recargo de mora, descuento por hermanos, pagos únicos, glosas, factura
 * electrónica), el atajo `?pay=` del Inicio y el ÚNICO flujo de pago
 * (PaymentCheckoutModal: sesión firmada por el BFF o comprobante).
 *
 * El atleta adulto NO usa esta vista: el efecto de abajo lo redirige a
 * /athlete-payments (AthletePaymentsPage) antes de cargar nada, como siempre.
 */
import { useState, useEffect, useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Loader2, Zap, User, FileText } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { PaymentCheckoutModal } from '@/components/payment/PaymentCheckoutModal';
import { conceptoInicialDeUrl, type ConceptoInicial } from '@/components/payment/checkoutConcepto';
import { isOneTimeCategory } from '@/lib/payment-accounts';
import { GlosaRespondModal } from '@/components/payment/GlosaRespondModal';
import { listMine as listMyGlosas, OPEN_GLOSA_STATUSES, type Glosa } from '@/lib/api/glosas';
import { formatCurrency } from '@/lib/utils';
import { normalizeReceiptUrl } from '@/lib/normalizeReceiptUrl';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/integrations/supabase/client';
import { calcEarlyPaymentDiscount, modoProntoPago } from '@/lib/earlyPaymentDiscount';
import { MiFacturaElectronicaCard } from '@/components/billing/MiFacturaElectronicaCard';
import { DebitoAutomaticoCard, DebitoSugerenciaBanner } from '@/components/autopay/DebitoAutomaticoCard';
import { useMiDebito } from '@/components/autopay/useMiDebito';
import { AcuPagosV2 } from '@/components/parent/v2/AcuPagosV2';
import { fetchAjustesDeCobros } from '@/lib/cobrosAbiertos';
import { PagarPorPlazos } from '@/components/familia/plazos/PagarPorPlazos';
import { cobrosParaPlazos } from '@/components/familia/plazos/plazosModelo';
import { PAYABLE_STATES, rotuloCobroSinHijo, rowTitle, type Transaction } from '@/components/parent/v2/pagosModel';

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

const MONTH_NAMES_ES = [
  'Enero','Febrero','Marzo','Abril','Mayo','Junio',
  'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'
];
const formatPeriodLabel = (year?: number | null, month?: number | null): string | null =>
  year && month && month >= 1 && month <= 12 ? `${MONTH_NAMES_ES[month - 1]} ${year}` : null;

/**
 * Cuando el vencimiento cae en un mes posterior al periodo (p.ej. "primer cobro
 * sin recargo" de Dreamers: el trigger de BD mueve el vencimiento al corte del
 * mes siguiente pero deja el periodo en el mes de alta a propósito, para el
 * dedup y la exoneración de mora), mostrarle al acudiente el mes del periodo
 * confunde: un cobro que vence el 01/11 etiquetado "Octubre" parece atrasado.
 * Se muestra el mes del vencimiento en ese caso puntual; period_year/period_month
 * en BD no se tocan.
 */
const displayPeriodLabel = (
  year?: number | null,
  month?: number | null,
  dueDate?: string | null,
): string | null => {
  if (!year || !month || month < 1 || month > 12) return null;
  const m = dueDate ? /^(\d{4})-(\d{2})-\d{2}/.exec(dueDate) : null;
  if (m) {
    const dueYear = Number(m[1]);
    const dueMonth = Number(m[2]);
    if (dueYear * 12 + dueMonth > year * 12 + month) {
      return formatPeriodLabel(dueYear, dueMonth);
    }
  }
  return formatPeriodLabel(year, month);
};

// Estados que el atajo `?pay=` del Inicio puede abrir solo (sin cambios en V2:
// un abono `partial` se paga desde la lista, no desde el atajo).
const DIRECTLY_PAYABLE_STATES = ['pending', 'overdue', 'rejected', 'failed'];

// Lo que el modal de pago necesita de un cobro, armado en un solo lugar. El
// monto es el saldo de la fila: el modal aplica pronto pago y el BFF decide el
// valor final (create-session); nunca se cobra lo que diga el cliente.
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

export default function MyPaymentsPage() {
  const { user, profile } = useAuth();
  const { toast } = useToast();
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  // Glosas abiertas del acudiente, indexadas por payment_id (para el botón Responder).
  const [glosaMap, setGlosaMap] = useState<Map<string, Glosa>>(new Map());
  const [respondingGlosa, setRespondingGlosa] = useState<Glosa | null>(null);
  const [loading, setLoading] = useState(true);
  // Error al cargar ≠ «no debes nada» (UX-2): antes el catch dejaba la lista
  // vacía y la pantalla parecía al día.
  const [loadError, setLoadError] = useState(false);
  const [showCheckout, setShowCheckout] = useState(false);
  // «Ya transferí» abre el checkout con transferencia marcada (B7).
  const [checkoutMethod, setCheckoutMethod] = useState<'transfer' | undefined>(undefined);
  // Cobros marcados que faltan por pagar. El checkout es de UN cobro por vez
  // (no hay pago múltiple en el BFF): al terminar uno con éxito se abre el
  // siguiente con el mismo modal.
  const [payQueue, setPayQueue] = useState<Transaction[]>([]);
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
    /** «Pagar otro concepto» con un motivo ya elegido (`?motivo=`). */
    conceptoInicial?: ConceptoInicial;
  } | null>(null);
  // Motivo de `?motivo=` esperando que la familia elija para quién es (varios hijos).
  const [motivoPedido, setMotivoPedido] = useState<ConceptoInicial | null>(null);

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
      setLoadError(false);

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

      const [{ data: payments, error: paymentsError }, { count: inscripcionesPropias }] = await Promise.all([
        paymentsQuery,
        // ¿El acudiente entrena él mismo? Solo así un cobro sin hijo es «Tú (como atleta)» (B8).
        supabase
          .from('enrollments')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', user?.id || '')
          .is('child_id', null),
      ]);
      if (paymentsError) throw paymentsError;
      const tieneInscripcionPropia = (inscripcionesPropias ?? 0) > 0;

      // ── PASO 2.5: Hidratar period_year/period_month desde la tabla base ──
      // La vista `payments_with_installments` no proyecta estas columnas
      // (creada antes de la migracion 20260503000004). Hacemos un select
      // directo a payments para obtenerlas por id. Si en el futuro la vista
      // se regenera incluyendo estos campos, esta query se vuelve redundante
      // pero no rompe nada (devuelve los mismos valores).
      const paymentIds = (payments || []).map((p: any) => p.id).filter(Boolean);
      let periodMap: Record<string, { period_year: number | null; period_month: number | null; late_fee_amount?: number | null; created_at: string; early_payment_discount_applied?: number | null; sibling_discount_applied?: number | null; child_id?: string | null; parent_id?: string | null; school_id: string; last_failure_reason?: string | null; last_failure_at?: string | null; requires_review?: boolean | null; payment_category?: string | null; payment_method?: string | null; payment_provider?: string | null }> = {};
      // Ajustes de la escuela (mes anulado por «no asistió», valor por cambio de
      // plan): se piden en paralelo y, si fallan, el cobro se ve igual sin la nota.
      const ajustesPromise = fetchAjustesDeCobros(paymentIds);
      if (paymentIds.length > 0) {
        const { data: periodRows } = await supabase
          .from('payments')
          .select('id, period_year, period_month, late_fee_amount, created_at, early_payment_discount_applied, sibling_discount_applied, child_id, parent_id, school_id, last_failure_reason, last_failure_at, requires_review, payment_category, payment_method, payment_provider')
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
            payment_method: r.payment_method ?? null,
            payment_provider: r.payment_provider ?? null,
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

      const ajustes = await ajustesPromise;
      const txns: Transaction[] = (payments || []).map((p: any) => {
        const ajuste = ajustes.get(p.id);
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
          concept: p.concept,
          child_id: p.child_id,
          // Acudiente que además es atleta: sus cobros propios llegan con él como
          // pagador y sin hijo (child_id NULL). Se muestran junto a los de los
          // hijos, rotulados como suyos (spec cambio-de-rol-atleta-acudiente.md).
          child_name: p.child_id
            ? (childNameMap[p.child_id] || 'Deportista')
            : rotuloCobroSinHijo(p, user?.id, childrenData || [], tieneInscripcionPropia),
          // Medio real (payments.payment_method + pasarela). Antes se leía
          // payment_type, que es one_time/monthly, no el medio.
          pay_method: periodMap[p.id]?.payment_method ?? null,
          pay_provider: periodMap[p.id]?.payment_provider ?? null,
          status: p.status === 'paid' ? 'approved' : p.status,
          reference: p.receipt_number || `SP-${p.id.slice(0, 8).toUpperCase()}`,
          transaction_date: p.payment_date || p.created_at,
          due_date: p.due_date ?? null,
          receipt_url: p.receipt_url,
          period_year:  periodMap[p.id]?.period_year ?? p.period_year ?? null,
          period_month: periodMap[p.id]?.period_month ?? p.period_month ?? null,
          period_label: displayPeriodLabel(
            periodMap[p.id]?.period_year ?? p.period_year,
            periodMap[p.id]?.period_month ?? p.period_month,
            p.due_date,
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
          ajuste_kind: ajuste?.kind ?? null,
          ajuste_antes: ajuste ? Number(ajuste.amount_before) : null,
          ajuste_motivo: ajuste?.motivo ?? null,
          ajuste_at: ajuste?.created_at ?? null,
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
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  };

  // Abre el ÚNICO checkout (PaymentCheckoutModal) para un cobro existente.
  const openCheckoutFor = (p: Transaction, metodo?: 'transfer') => {
    setSelectedPayment(toSelectedPayment(p));
    setCheckoutMethod(metodo);
    setShowCheckout(true);
  };

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
    setPayQueue([]);
    openCheckoutFor(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- corre una sola vez, al terminar la carga
  }, [loading, transactions, searchParams]);

  // «Pagar otro concepto» (modo create del mismo checkout) para un hijo, con el
  // motivo ya elegido si vino de `?motivo=`.
  const openOtroConcepto = (enroll: Enrollment, conceptoInicial?: ConceptoInicial) => {
    setPayQueue([]);
    setSelectedPayment({
      childId: enroll.child_id,
      childName: enroll.children?.full_name || 'Deportista',
      teamId: enroll.team_id || undefined,
      teamName: enroll.teams?.name || 'Mensualidad Deportista',
      amount: enroll.teams?.price_monthly || 0,
      schoolId: enroll.school_id,
      ...(conceptoInicial ? { conceptoInicial } : {}),
    });
    setCheckoutMethod(undefined);
    setShowCheckout(true);
  };

  // Atajo `?motivo=<clave>` (catálogo lib/motivosDeCobro: enlaces de WhatsApp,
  // correos): abre «Pagar otro concepto» con ese motivo preseleccionado. Con un
  // solo hijo, directo; con varios, primero «¿Para quién es el pago?». Una clave
  // que no está en el catálogo se ignora. `?pay=` manda si vienen los dos. El
  // parámetro se limpia para que un refresh no reabra el modal.
  const motivoAbiertoRef = useRef(false);
  useEffect(() => {
    if (loading || motivoAbiertoRef.current || !searchParams.get('motivo')) return;
    motivoAbiertoRef.current = true;
    if (searchParams.get('pay')) return;
    const motivo = conceptoInicialDeUrl(searchParams.get('motivo'));
    setSearchParams(prev => { prev.delete('motivo'); return prev; }, { replace: true });
    if (!motivo || enrollments.length === 0) return;
    if (enrollments.length === 1) {
      openOtroConcepto(enrollments[0], motivo);
      return;
    }
    setMotivoPedido(motivo);
    setShowChildPicker(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- corre una sola vez, al terminar la carga
  }, [loading, enrollments, searchParams]);

  // «Pagar $ X» / «Ya transferí» con los cobros marcados. El BFF firma la
  // sesión de UN cobro (no existe pago múltiple), así que se pagan en fila con
  // el mismo modal: el primero ya, el resto al terminar cada uno con éxito.
  const startPaying = (rows: Transaction[]) => {
    const payable = rows.filter(t => PAYABLE_STATES.includes(t.status));
    if (payable.length === 0) return;
    const [first, ...rest] = payable;
    setPayQueue(rest);
    if (rest.length > 0) {
      toast({
        title: `Vas a pagar ${payable.length} cobros, uno por uno`,
        description: `Empezamos por ${rowTitle(first)}.`,
      });
    }
    openCheckoutFor(first);
  };

  // «Ya transferí»: UN comprobante para UN cobro, nunca en fila. La base no deja
  // usar el mismo comprobante en dos cobros (uq_payments_school_receipt_hash): si
  // la familia hizo una sola transferencia por varios cobros y la subiera en
  // cada uno, del segundo en adelante vería «Comprobante ya usado» y quedarían
  // sin pagar aunque la plata ya llegó.
  const startUploadingProof = (rows: Transaction[]) => {
    const payable = rows.filter(t => PAYABLE_STATES.includes(t.status));
    if (payable.length === 0) return;
    setPayQueue([]);
    if (payable.length > 1) {
      toast({
        title: 'Un comprobante por cobro',
        description: `Sube aquí el comprobante de ${rowTitle(payable[0])}. Si hiciste una sola transferencia por varios cobros, súbela aquí y avísale a la escuela para que la reparta.`,
      });
    }
    openCheckoutFor(payable[0], 'transfer');
  };

  // Si la familia cierra el modal (o el pago no pasa) con cobros en fila, la
  // fila se corta, pero diciéndolo: nunca en silencio.
  const pagoExitosoRef = useRef(false);
  const handleCheckoutOpenChange = (open: boolean) => {
    setShowCheckout(open);
    if (open) return;
    if (!pagoExitosoRef.current && payQueue.length > 0) {
      toast({
        title: `Quedan ${payQueue.length} ${payQueue.length === 1 ? 'cobro' : 'cobros'} por pagar`,
        description: 'Los puedes pagar cuando quieras desde «Por pagar».',
      });
      setPayQueue([]);
    }
    pagoExitosoRef.current = false;
  };

  // El modal llama onSuccess y enseguida se cierra solo (onOpenChange(false)):
  // el siguiente de la fila se abre en el próximo tick, con el modal remontado
  // (key) para que no herede el estado del pago anterior.
  const handleCheckoutSuccess = () => {
    pagoExitosoRef.current = true;
    void fetchPaymentData();
    if (payQueue.length === 0) return;
    const [next, ...rest] = payQueue;
    setPayQueue(rest);
    setTimeout(() => {
      toast({ title: 'Listo', description: `Sigue: ${rowTitle(next)}.` });
      openCheckoutFor(next);
    }, 0);
  };

  const handleShowProof = async (receiptUrl: string, concept: string, amount: number) => {
    if (!receiptUrl) return;

    // Short-circuit si ya es URL pública directa
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
        title: 'No pudimos abrir el recibo',
        description: 'Inténtalo de nuevo en un momento.',
        variant: 'destructive',
      });
    }
  };

  // Débito automático: igual que antes de la V2 (sugerencia + tarjeta). Ya está
  // en producción para las escuelas que lo ofrecen; la V2 no quita módulos.
  // Los avisos enlazan a /my-payments#debito.

  const childrenForStatement = [...new Map(enrollments.filter(e => e.child_id).map(e => [e.child_id, e])).values()];
  const loadState = loading && transactions.length === 0 ? 'loading' : loadError ? 'error' : 'ready';

  return (
    <div className="relative">
      <AcuPagosV2
        state={loadState}
        transactions={transactions}
        invoiceMap={invoiceMap}
        onRetry={() => { void fetchPaymentData(); }}
        onPay={startPaying}
        onUploadProof={startUploadingProof}
        onShowReceipt={(t) => handleShowProof(t.receipt_url || '', t.concept || '', Number(t.amount_paid || t.amount))}
        canClarify={(t) => glosaMap.has(t.id)}
        onClarify={(t) => setRespondingGlosa(glosaMap.get(t.id) ?? null)}
        porPagarFooter={
          <>
            <DebitoSugerenciaBanner data={debito.data} userId={user?.id} onActivar={setActivarDebitoSchoolId} />
            <div id="debito" className="scroll-mt-20">
              <DebitoAutomaticoCard
                data={debito.data}
                reload={debito.reload}
                activarSchoolId={activarDebitoSchoolId}
                onActivarSchoolIdChange={setActivarDebitoSchoolId}
              />
            </div>
            {/* Pagar por plazos: solo aparece si la escuela lo tiene prendido. */}
            <PagarPorPlazos cobros={cobrosParaPlazos(transactions)} />
            {/* Adelantar una mensualidad sin cobro creado (modo create del mismo modal). */}
            <div className="text-center">
              <Button variant="link" className="min-h-touch text-sm" onClick={() => setShowChildPicker(true)}>
                ¿Quieres adelantar un pago? Pagar otro concepto
              </Button>
            </div>
          </>
        }
        pagadosFooter={
          <>
            {childrenForStatement.length > 0 && (
              <div className="flex flex-wrap justify-center gap-2">
                {childrenForStatement.map((e) => (
                  <Button key={e.child_id} asChild variant="outline" size="sm" className="min-h-touch">
                    <Link to={`/estado-cuenta?child_id=${e.child_id}`}>
                      <FileText className="mr-2 h-4 w-4" aria-hidden="true" />
                      Estado de cuenta de {e.children?.full_name || 'tu hijo'}
                    </Link>
                  </Button>
                ))}
              </div>
            )}
            {/* ¿Quiere factura electrónica a su nombre? Mismo bloque que /p/:token. */}
            <MiFacturaElectronicaCard />
          </>
        }
      />

      {/* Child Picker Dialog */}
      <Dialog open={showChildPicker} onOpenChange={(o) => { setShowChildPicker(o); if (!o) setMotivoPedido(null); }}>
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
                      openOtroConcepto(enroll, motivoPedido ?? undefined);
                      setMotivoPedido(null);
                      setShowChildPicker(false);
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
                          <p className={`text-xs italic truncate ${isPT ? 'text-zinc-500' : 'text-muted-foreground'}`}>
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
          // Remonta al cambiar de cobro (pago en fila): el modal guarda estado
          // interno del intento anterior (resultado, cobro creado).
          key={`${selectedPayment.paymentId ?? `nuevo-${selectedPayment.childId}-${selectedPayment.teamName}`}-${checkoutMethod ?? 'auto'}`}
          open={showCheckout}
          onOpenChange={handleCheckoutOpenChange}
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
          initialMethod={checkoutMethod}
          initialConceptType={selectedPayment.paymentId ? undefined : selectedPayment.conceptoInicial}
          mode={selectedPayment.paymentId ? 'update' : 'create'}
          onSuccess={handleCheckoutSuccess}
        />
      )}

      {/* Responder glosa (aclaración) */}
      <GlosaRespondModal
        glosa={respondingGlosa}
        open={!!respondingGlosa}
        onOpenChange={(o) => { if (!o) setRespondingGlosa(null); }}
        onSuccess={fetchPaymentData}
      />

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
