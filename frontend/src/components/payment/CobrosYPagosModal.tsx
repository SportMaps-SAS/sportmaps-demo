import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Loader2, Users, User } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useSchoolContext } from '@/hooks/useSchoolContext';
import { useEntitlements } from '@/hooks/useEntitlements';
import { useToast } from '@/hooks/use-toast';
import { todayColombia } from '@/lib/dateUtils';
import { chargeCategoryOf, type PaymentChargeCategory } from '@/lib/payment-accounts';
import { isCobrosYPagosEnabled } from '@/lib/cobrosYPagosFlag';
import { formatHourBankMinutes } from '@/lib/hourBank';
import {
    addDays,
    adjustmentLabel,
    buildMultiRequest,
    buildSingleRequest,
    canChargeOverage,
    canManageCharges,
    computeMulti,
    computeSingle,
    emptyDiscount,
    formatPesos,
    newClientRequestId,
    newLineDraft,
    newPendingDraft,
    formatHoras,
    pendingBlockReason,
    primaryButtonState,
    SKIP_REASON_LABEL,
    requestSignature,
    PREVIEW_DEBOUNCE_MS,
    PREVIEW_RATE_LIMIT_MESSAGE,
    rateLimitRetryDelayMs,
    shouldRequestPreview,
    type GlobalDiscountDraft,
    type LineCalc,
    type MultiLineCalc,
    type NewLineDraft,
    type PendingDraft,
} from '@/lib/cobrosYPagos';
import {
    chargeBatchesApi,
    normalizeCobrosRecientes,
    normalizeDuplicate,
    textoCobroReciente,
    toChargeBatchError,
    type AthleteDuplicate,
    type AthleteRef,
    type CobroRecienteAviso,
    type ChargeBatchPreview,
    type ChargeBatchRequest,
    type ChargeBatchResult,
    type ChargeOverride,
    type ChargeSuggestions,
    type OpenCharge,
    type TargetKind,
} from '@/lib/api/chargeBatches';
import {
    decidirComprobante,
    horasAPagarDeLineas,
    horasPorSeparar,
    separarLineas,
    type DecisionComprobante,
    type HorasPorSeparar,
} from '@/lib/separarHoras';
import { RegisterCashPaymentModal } from './RegisterCashPaymentModal';
import { AthletePicker } from './cobros-y-pagos/AthletePicker';
import { NewAthleteForm } from './cobros-y-pagos/NewAthleteForm';
import { PendingChargesSection } from './cobros-y-pagos/PendingChargesSection';
import { NewChargeLines } from './cobros-y-pagos/NewChargeLines';
import { GlobalDiscount, type GlobalTarget } from './cobros-y-pagos/GlobalDiscount';
import { PaymentBlock } from './cobros-y-pagos/PaymentBlock';
import { MultiTargetPicker } from './cobros-y-pagos/MultiTargetPicker';
import {
    emptyMultiTarget,
    emptyNewAthlete,
    emptyPaymentDraft,
    hasUnresolvedDuplicates,
    newAthleteError,
    newAthletePayload,
    paymentDraftError,
    paymentPayload,
    type MultiTargetValue,
    type NewAthleteDraft,
    type PaymentDraft,
} from './cobros-y-pagos/drafts';
import { PreviewSummary } from './cobros-y-pagos/PreviewSummary';
import { ResultScreen } from './cobros-y-pagos/ResultScreen';
import { AnnulBatchDialog } from './OperacionesTab';
import { athleteRefOf, type SchoolAthlete } from './cobros-y-pagos/types';

export interface CobrosYPagosModalProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSuccess: () => void;
    /** Atleta preelegido (id de la vista school_athletes): ficha / «Estado de cuenta». */
    initialAthleteId?: string;
    /** Abrir en modo varios (p. ej. «Cobrar a este equipo»). */
    initialMode?: 'single' | 'multi';
    /** Equipo preelegido en modo varios. */
    initialTeamId?: string;
    /** El atleta no se puede cambiar (abierto desde su ficha). Por defecto, si viene initialAthleteId. */
    lockAthlete?: boolean;
    /** «Ver operación» en la pantalla de resultado. */
    onViewOperations?: () => void;
}

/**
 * Punto de entrada único de «Registrar pago» / «Cobros y pagos».
 *
 * Con el interruptor apagado (lib/cobrosYPagosFlag.ts) abre el modal de
 * siempre, sin ningún cambio. Encendido, abre «Cobros y pagos» (spec
 * docs/specs/cobros-multiples.md §10) solo para owner/admin/school_admin; para
 * cualquier otro rol no se renderiza (el BFF es el gate real, §9.1).
 */
export function CobrosYPagosModal(props: CobrosYPagosModalProps) {
    const { currentUserRole } = useSchoolContext();
    if (!isCobrosYPagosEnabled()) {
        if (props.initialMode === 'multi') return null; // el modal viejo no tiene modo varios
        return (
            <RegisterCashPaymentModal
                open={props.open}
                onOpenChange={props.onOpenChange}
                onSuccess={props.onSuccess}
                initialAthleteId={props.initialAthleteId}
            />
        );
    }
    if (!canManageCharges(currentUserRole)) return null;
    return <CobrosYPagosDialog {...props} />;
}

export function CobrosYPagosDialog({
    open, onOpenChange, onSuccess, initialAthleteId, initialMode = 'single', initialTeamId, lockAthlete, onViewOperations,
}: CobrosYPagosModalProps) {
    const { schoolId, schoolName, currentUserRole, teams } = useSchoolContext();
    const { hasAddon } = useEntitlements();
    const { toast } = useToast();
    const today = todayColombia();
    const defaultDue = addDays(today, 10);
    const canDiscount = canManageCharges(currentUserRole);
    const canOverage = canChargeOverage(currentUserRole);

    const [mode, setMode] = useState<'single' | 'multi'>(initialMode);
    const clientRequestId = useRef<string>(newClientRequestId());
    const enviando = useRef(false);

    // Atletas de la escuela (lectura; toda escritura va por el BFF)
    const [athletes, setAthletes] = useState<SchoolAthlete[]>([]);
    const [loadingAthletes, setLoadingAthletes] = useState(false);
    const [athleteId, setAthleteId] = useState<string | null>(null);
    const [newAthleteOn, setNewAthleteOn] = useState(false);
    const [newAthlete, setNewAthlete] = useState<NewAthleteDraft>(emptyNewAthlete());
    const [serverDuplicates, setServerDuplicates] = useState<AthleteDuplicate[] | undefined>(undefined);

    // Modo un atleta
    const [charges, setCharges] = useState<OpenCharge[]>([]);
    const [drafts, setDrafts] = useState<Record<string, PendingDraft>>({});
    const [loadingCharges, setLoadingCharges] = useState(false);
    const [chargesError, setChargesError] = useState<string | null>(null);
    const [severalMonthsMin, setSeveralMonthsMin] = useState<number | null>(3);
    const [suggestions, setSuggestions] = useState<ChargeSuggestions | null>(null);
    const [payment, setPayment] = useState<PaymentDraft>(emptyPaymentDraft(today, true));

    // Común
    const [lines, setLines] = useState<NewLineDraft[]>([]);
    const [global, setGlobal] = useState<GlobalDiscountDraft>({ ...emptyDiscount(), enabled: false });
    const [notify, setNotify] = useState(false);

    // Modo varios
    const [multi, setMulti] = useState<MultiTargetValue>(emptyMultiTarget(initialTeamId));
    const [multiResolved, setMultiResolved] = useState<{ target: { kind: TargetKind; ids: string[] }; athletes: AthleteRef[]; withoutPayer: number; label: string }>({
        target: { kind: 'team', ids: [] }, athletes: [], withoutPayer: 0, label: '',
    });
    const [omitWithoutPayer, setOmitWithoutPayer] = useState(false);

    // Vista previa / envío
    const [preview, setPreview] = useState<ChargeBatchPreview | null>(null);
    const [previewSig, setPreviewSig] = useState<string | null>(null);
    const [previewLoading, setPreviewLoading] = useState(false);
    const [previewError, setPreviewError] = useState<string | null>(null);
    const [previewNonce, setPreviewNonce] = useState(0);
    const [overrides, setOverrides] = useState<ChargeOverride[]>([]);
    const [submitting, setSubmitting] = useState(false);
    const [submitError, setSubmitError] = useState<string | null>(null);
    /** El BFF dijo «este mismo cobro ya se registró hace X min»: se pide confirmar antes de crearlo otra vez. */
    const [duplicadoReciente, setDuplicadoReciente] = useState<CobroRecienteAviso[] | null>(null);
    const [result, setResult] = useState<ChargeBatchResult | null>(null);
    // Lo que hace falta para reintentar la suma de horas vendidas si no entró (se guarda al confirmar).
    const [ventaDeHoras, setVentaDeHoras] = useState<{ athlete: AthleteRef; enrollment_id: string; extra_hours: number } | null>(null);
    const [reintentandoHoras, setReintentandoHoras] = useState(false);
    const [annulOpen, setAnnulOpen] = useState(false);
    // «Separar las horas»: las líneas de horas que salieron de ESTA operación y se cobran en una segunda.
    const [horasAparte, setHorasAparte] = useState<HorasPorSeparar<NewLineDraft> | null>(null);
    const previewSeq = useRef(0);
    /** Cuerpo (firma) de la vista previa en camino o esperando su reintento tras un 429. */
    const previewInFlightSig = useRef<string | null>(null);
    const previewRetryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const resetAll = useCallback(() => {
        clientRequestId.current = newClientRequestId();
        setDuplicadoReciente(null);
        setMode(initialMode);
        setAthleteId(null);
        setNewAthleteOn(false);
        setNewAthlete(emptyNewAthlete());
        setServerDuplicates(undefined);
        setCharges([]);
        setDrafts({});
        setChargesError(null);
        setSuggestions(null);
        setPayment(emptyPaymentDraft(todayColombia(), true));
        setLines(initialMode === 'multi' ? [newLineDraft({ category: 'torneo', due_date: addDays(todayColombia(), 10), amount: null, pay: false })] : []);
        setGlobal({ ...emptyDiscount(), enabled: false });
        setNotify(false);
        setMulti(emptyMultiTarget(initialTeamId));
        setOmitWithoutPayer(false);
        // Una vista previa en camino o un reintento pendiente (429) no deben llegar después de limpiar.
        previewSeq.current++;
        previewInFlightSig.current = null;
        if (previewRetryTimer.current) { clearTimeout(previewRetryTimer.current); previewRetryTimer.current = null; }
        setPreview(null);
        setPreviewSig(null);
        setPreviewError(null);
        setPreviewLoading(false);
        setOverrides([]);
        setSubmitError(null);
        setResult(null);
        setHorasAparte(null);
    }, [initialMode, initialTeamId]);

    // Al abrir: id de idempotencia nuevo y atletas de la escuela
    useEffect(() => {
        if (!open) return;
        resetAll();
        if (!schoolId) return;
        let cancelled = false;
        setLoadingAthletes(true);
        (async () => {
            const { data, error } = await supabase
                .from('school_athletes')
                .select('id, athlete_type, full_name, parent_id, parent_name, parent_email, parent_phone, team_id, team_name, plan_name, offering_plan_id, enrollment_status, is_active')
                .eq('school_id', schoolId)
                .eq('is_active', true)
                .order('full_name');
            if (cancelled) return;
            setLoadingAthletes(false);
            if (error) {
                toast({ title: 'No se pudieron cargar los deportistas', description: error.message, variant: 'destructive' });
                return;
            }
            // Un atleta con dos inscripciones sale dos veces en la vista: uno por id.
            const seen = new Set<string>();
            const list = ((data ?? []) as SchoolAthlete[]).filter((a) => a.id && !seen.has(a.id) && seen.add(a.id));
            setAthletes(list);
            if (initialAthleteId && list.some((a) => a.id === initialAthleteId)) setAthleteId(initialAthleteId);
        })();
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, schoolId]);

    const selected = athletes.find((a) => a.id === athleteId) ?? null;
    const athleteRef: AthleteRef | null = selected ? athleteRefOf(selected) : null;

    const loadAthleteData = useCallback(async (ref: AthleteRef, preselectOldest: boolean) => {
        setLoadingCharges(true);
        setChargesError(null);
        try {
            const [oc, sg] = await Promise.all([
                chargeBatchesApi.openCharges(ref),
                chargeBatchesApi.suggestions(ref).catch(() => null),
            ]);
            const list = (oc.charges ?? []).slice().sort((a, b) => String(a.due_date ?? '').localeCompare(String(b.due_date ?? '')));
            setCharges(list);
            setSeveralMonthsMin(oc.suggestions?.varios_meses?.min_months ?? 3);
            setSuggestions(sg);
            setDrafts((prev) => {
                const next: Record<string, PendingDraft> = {};
                const firstFree = list.find((c) => !pendingBlockReason(c));
                for (const c of list) {
                    next[c.id] = prev[c.id] ?? newPendingDraft(c.id, preselectOldest && c.id === firstFree?.id);
                }
                return next;
            });
        } catch (e) {
            setCharges([]);
            setChargesError(toChargeBatchError(e).message);
        } finally {
            setLoadingCharges(false);
        }
    }, []);

    useEffect(() => {
        if (!open || mode !== 'single' || !athleteRef) { return; }
        setDrafts({});
        loadAthleteData(athleteRef, athleteRef.id === initialAthleteId);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, mode, athleteRef?.id, athleteRef?.type]);

    // ── Cálculo local ──────────────────────────────────────────────────────────
    const pendingInput = useMemo(
        () => charges.filter((c) => drafts[c.id]).map((c) => ({ charge: c, draft: drafts[c.id] })),
        [charges, drafts],
    );
    // Hermanos / militar que la RPC aplica sola a una mensualidad nueva (Q17): se
    // leen de la última vista previa para que el monto local (y lo que se paga)
    // cuadre con el del servidor. Converge en una vuelta más de vista previa.
    const autoDiscounts = useMemo(() => {
        const out: Record<string, { amount: number; labels: string[] }> = {};
        for (const l of preview?.lines ?? []) {
            if (!l.ref?.startsWith('new:')) continue;
            const autos = (l.adjustments ?? []).filter((a) => (a.origin === 'hermanos' || a.origin === 'militar') && (a.kind ?? 'descuento') === 'descuento');
            if (autos.length) out[l.ref] = { amount: autos.reduce((x, a) => x + a.amount, 0), labels: autos.map(adjustmentLabel) };
        }
        return out;
    }, [preview]);
    const single = useMemo(
        () => computeSingle({ pending: newAthleteOn ? [] : pendingInput, lines, global, paymentOn: payment.on, autoDiscounts: mode === 'single' ? autoDiscounts : undefined }),
        [pendingInput, lines, global, payment.on, newAthleteOn, autoDiscounts, mode],
    );
    // Comprobante vs. total cuando se venden horas por adelantado: las horas solo van en la misma
    // operación si el comprobante cubre todo (si no, se bloquea y se ofrece «Separar las horas»).
    const payAmountsDeLineas = useMemo(() => {
        const porRef = new Map(single.lines.map((l) => [l.ref, l.payAmount]));
        return lines.map((_, i) => porRef.get(`new:${i}`) ?? 0);
    }, [single.lines, lines]);
    const comprobante: DecisionComprobante = useMemo(() => (
        mode === 'single' && payment.on && !newAthleteOn
            ? decidirComprobante({
                metodo: payment.method,
                tieneComprobante: !!payment.receiptUrl,
                montoLeido: payment.ocr?.extractedAmount,
                totalAPagar: single.toPay.total,
                horasAPagar: horasAPagarDeLineas(lines, payAmountsDeLineas),
            })
            : { tipo: 'ok' }
    ), [mode, payment, newAthleteOn, single.toPay.total, lines, payAmountsDeLineas]);

    const separarHoras = () => {
        const { principal, horas } = separarLineas(lines);
        if (horas.length === 0 || principal.length + pendingInput.filter((x) => x.draft.selected).length === 0) return;
        setHorasAparte(horasPorSeparar(horas, horasAPagarDeLineas(lines, payAmountsDeLineas)));
        setLines(principal);
    };
    const volverAIncluirHoras = () => {
        if (!horasAparte) return;
        setLines((ls) => [...ls, ...horasAparte.lineas]);
        setHorasAparte(null);
    };
    // Segunda operación: mismo atleta, solo las horas, con su propio pago y comprobante.
    const registrarHorasAparte = () => {
        const h = horasAparte;
        if (!h) return;
        clientRequestId.current = newClientRequestId();
        previewSeq.current++;
        previewInFlightSig.current = null;
        if (previewRetryTimer.current) { clearTimeout(previewRetryTimer.current); previewRetryTimer.current = null; }
        setResult(null);
        setVentaDeHoras(null);
        setLines(h.lineas);
        setHorasAparte(null);
        setPayment(emptyPaymentDraft(todayColombia(), true));
        setDrafts({});
        setGlobal({ ...emptyDiscount(), enabled: false });
        setNotify(false);
        setPreview(null);
        setPreviewSig(null);
        setPreviewError(null);
        setPreviewLoading(false);
        setOverrides([]);
        setSubmitError(null);
        if (athleteRef) void loadAthleteData(athleteRef, false);
    };

    const multiAthletes = useMemo(() => {
        if (!omitWithoutPayer) return multiResolved.athletes;
        const withPayer = new Set(athletes.filter((a) => a.athlete_type === 'adult' || !!a.parent_id).map((a) => a.id));
        return multiResolved.athletes.filter((a) => a.type === 'adult' || withPayer.has(a.id));
    }, [multiResolved.athletes, omitWithoutPayer, athletes]);
    const multiCalc = useMemo(() => computeMulti({ lines, global, athletes: multiAthletes.length }), [lines, global, multiAthletes.length]);

    const singleTargetReady = newAthleteOn ? !newAthleteError(newAthlete) : !!athleteRef;
    const extraErrors: string[] = [];
    if (mode === 'single') {
        if (newAthleteOn) {
            const e = newAthleteError(newAthlete);
            if (e) extraErrors.push(e);
            if (lines.some((l) => l.category === 'mensualidad')) extraErrors.push('Un atleta nuevo no tiene plan: no se le puede generar mensualidad.');
        }
        const pe = paymentDraftError(payment, today);
        if (pe && single.toPay.n > 0) extraErrors.push(pe);
        for (const l of lines) if (l.due_date < today) extraErrors.push('El vencimiento no puede ser antes de hoy.');
        if (comprobante.tipo === 'bloquear') extraErrors.push('El comprobante no cubre el total con las horas: sepáralas o corrige los montos.');
    } else {
        if (multiAthletes.length > 200) extraErrors.push('Máximo 200 atletas por lote: divide por equipo o plan.');
        if (multiAthletes.length * lines.length > 600) extraErrors.push('Máximo 600 cobros por lote.');
        for (const l of lines) if (l.due_date < today) extraErrors.push('El vencimiento no puede ser antes de hoy.');
    }
    const localErrors = mode === 'single' ? [...single.errors, ...extraErrors] : [...multiCalc.errors, ...extraErrors];

    // ── Cuerpo y vista previa ──────────────────────────────────────────────────
    const body: ChargeBatchRequest | null = useMemo(() => {
        if (mode === 'single') {
            if (!singleTargetReady) return null;
            return buildSingleRequest({
                athlete: newAthleteOn ? null : athleteRef,
                newAthlete: newAthleteOn ? newAthletePayload(newAthlete) : null,
                pending: newAthleteOn ? [] : pendingInput,
                lines,
                global,
                payment: payment.on ? paymentPayload(payment) : null,
                calc: single,
            });
        }
        if (multiAthletes.length === 0) return null;
        return buildMultiRequest({ target: multiResolved.target, athletes: multiAthletes, lines, global });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mode, singleTargetReady, newAthleteOn, athleteRef?.id, newAthlete, pendingInput, lines, global, payment, single, multiAthletes, multiResolved.target]);
    const sig = body ? requestSignature(body) : null;
    const somethingToDo = mode === 'single'
        ? single.toCreate.n + single.toPay.n + single.adjustOnly + single.exonerated > 0
        : lines.length > 0;
    const previewFresh = !!preview && !!sig && previewSig === sig;

    const runPreview = useCallback(async (b: ChargeBatchRequest, s: string, isRetry = false) => {
        if (previewRetryTimer.current) { clearTimeout(previewRetryTimer.current); previewRetryTimer.current = null; }
        const seq = ++previewSeq.current;
        previewInFlightSig.current = s;
        let retrying = false;
        setPreviewLoading(true);
        setPreviewError(null);
        try {
            const p = await chargeBatchesApi.preview(b);
            if (seq !== previewSeq.current) return;
            setPreview(p);
            setPreviewSig(s);
            if (p.duplicates?.length) setServerDuplicates(p.duplicates);
        } catch (e) {
            if (seq !== previewSeq.current) return;
            const err = toChargeBatchError(e);
            setPreview(null);
            setPreviewSig(null);
            if (err.code === 'RATE_LIMIT' && !isRetry) {
                // 429: aviso suave y UN reintento cuando el BFF diga (Retry-After).
                // Si mientras tanto cambia el cuerpo, la nueva vista previa cancela este.
                retrying = true;
                setPreviewError(PREVIEW_RATE_LIMIT_MESSAGE);
                previewRetryTimer.current = setTimeout(() => {
                    previewRetryTimer.current = null;
                    if (seq === previewSeq.current) void runPreview(b, s, true);
                }, rateLimitRetryDelayMs(err.retryAfterSeconds));
                return;
            }
            setPreviewError(err.message);
        } finally {
            if (seq === previewSeq.current && !retrying) {
                setPreviewLoading(false);
                previewInFlightSig.current = null;
            }
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => () => {
        if (previewRetryTimer.current) clearTimeout(previewRetryTimer.current);
    }, []);

    useEffect(() => {
        if (!open || result || !body || !sig || !somethingToDo || localErrors.length > 0) return;
        // Mismo cuerpo que la vista previa vigente o que la que va en camino: no se repite.
        if (!shouldRequestPreview(sig, previewSig, previewInFlightSig.current)) return;
        const t = setTimeout(() => runPreview(body, sig), PREVIEW_DEBOUNCE_MS);
        return () => clearTimeout(t);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, result, sig, somethingToDo, localErrors.length, previewNonce]);

    // Si el usuario cambia la operación, la pregunta «¿crear igual?» ya no aplica.
    useEffect(() => { setDuplicadoReciente(null); }, [sig]);

    const refreshPreview = () => {
        setPreviewSig(null);
        if (body && sig && localErrors.length === 0) runPreview(body, sig);
        else setPreviewNonce((n) => n + 1);
    };

    // ── Botón principal ────────────────────────────────────────────────────────
    const toCreate = previewFresh
        ? (preview!.to_create?.n ?? preview!.rows_to_create)
        : (mode === 'single' ? single.toCreate.n : multiCalc.estimatedRows);
    const toPay = mode === 'single' ? (previewFresh ? (preview!.to_pay?.n ?? single.toPay.n) : single.toPay.n) : 0;
    const dupBlock = mode === 'single' && newAthleteOn && hasUnresolvedDuplicates(newAthlete, serverDuplicates);
    // Lo que el servidor omitió (p. ej. «ya tiene la mensualidad de ese mes»), por línea y en texto.
    const skippedByLine = new Map<number, string>();
    if (previewFresh) {
        for (const s of preview?.skipped ?? []) {
            if (!skippedByLine.has(s.line_idx)) skippedByLine.set(s.line_idx, SKIP_REASON_LABEL[s.reason] ?? s.reason);
        }
    }
    const button = primaryButtonState({
        skippedReasons: [...skippedByLine.values()],
        mode,
        toCreate,
        toPay,
        adjustOnly: mode === 'single' ? single.adjustOnly : 0,
        errors: localErrors.length + (dupBlock ? 1 : 0) + (previewFresh && preview!.errors?.length ? preview!.errors.length : 0),
        previewFresh,
        previewLoading,
        submitting,
        noAthlete: mode === 'single' ? !singleTargetReady : multiAthletes.length === 0,
    });
    const buttonReason = dupBlock ? 'Decide si es una de las coincidencias o crea igual.' : button.reason;

    const retryHours = async () => {
        if (!result || !ventaDeHoras) return;
        setReintentandoHoras(true);
        try {
            const hb = await chargeBatchesApi.retryHourBankGrant(result.batch_id, ventaDeHoras);
            setResult({ ...result, hour_bank_grant: hb });
            if (hb.ok) toast({ title: 'Horas sumadas al banco', description: hb.hours != null ? `Se sumaron ${formatHoras(hb.hours)} h.` : undefined });
            else toast({ title: 'Todavía no se pudieron sumar', description: hb.message ?? 'Avisa a soporte.', variant: 'destructive' });
        } catch (e) {
            toast({ title: 'No se pudo reintentar', description: toChargeBatchError(e).message, variant: 'destructive' });
        } finally {
            setReintentandoHoras(false);
        }
    };

    /** `forzar`: el usuario ya vio «este mismo cobro se registró hace X min» y confirma que es otro (mismo client_request_id). */
    const submit = async (forzar = false) => {
        if (!body || !preview || !previewFresh || button.disabled) return;
        // Un doble clic llega antes de que React repinte el botón deshabilitado: el cerrojo va en una ref.
        if (enviando.current) return;
        enviando.current = true;
        setSubmitting(true);
        setSubmitError(null);
        setDuplicadoReciente(null);
        try {
            const r = await chargeBatchesApi.create({
                ...body,
                client_request_id: clientRequestId.current,
                preview_hash: preview.preview_hash,
                ...(overrides.length ? { overrides } : {}),
                ...(notify ? { notify_families: true } : {}),
                ...(forzar ? { confirmar_duplicado: true } : {}),
            });
            setResult(r);
            const lineaDeHoras = body.lines.find((x) => x.extra_hours != null && x.enrollment_id);
            setVentaDeHoras(lineaDeHoras && body.athletes[0]
                ? { athlete: body.athletes[0], enrollment_id: lineaDeHoras.enrollment_id as string, extra_hours: lineaDeHoras.extra_hours as number }
                : null);
            onSuccess();
            toast({ title: r.duplicated ? 'Ya estaba registrado' : 'Listo', description: r.duplicated ? 'Esta operación ya se había guardado: no se repitió nada.' : 'La operación quedó guardada.' });
            // Venta de horas adicionales: el cobro ya quedó; lo que sigue es decir QUÉ pasó con las horas.
            const hb = r.hour_bank_grant;
            if (hb) {
                if (hb.ok) {
                    toast({
                        title: hb.duplicated ? 'Las horas ya estaban sumadas' : 'Horas sumadas al banco',
                        description: hb.hours != null ? `Se sumaron ${formatHoras(hb.hours)} h${hb.available_minutes != null ? ` · disponibles ahora: ${formatHourBankMinutes(hb.available_minutes)}` : ''}.` : undefined,
                    });
                } else {
                    toast({ title: 'Ojo: las horas NO se sumaron al banco', description: hb.message ?? 'Avisa a soporte.', variant: 'destructive' });
                }
            }
        } catch (e) {
            const err = toChargeBatchError(e);
            if (err.code === 'COBRO_DUPLICADO_RECIENTE') {
                // No es un error: es una pregunta. Nada se creó; el botón «Sí, crear igual» reintenta con el flag.
                const dup = normalizeCobrosRecientes((err.body as { duplicates?: unknown } | undefined)?.duplicates) ?? [];
                setDuplicadoReciente(dup);
                return;
            }
            setSubmitError(err.message);
            if (err.code === 'ATLETA_DUPLICADO') {
                // F2 adjunta lo que mandó la RPC en `detalle` (la coincidencia o la lista).
                const b = (err.body ?? {}) as { duplicates?: unknown[]; match?: unknown; detalle?: { duplicates?: unknown[]; match?: unknown } & Record<string, unknown> };
                const raw = b.duplicates ?? b.detalle?.duplicates ?? (b.match ? [b.match] : b.detalle?.match ? [b.detalle.match] : b.detalle?.id ? [b.detalle] : []);
                setServerDuplicates(raw.map((m) => normalizeDuplicate(m)));
            }
            if (err.needsReload) {
                if (mode === 'single' && athleteRef && !newAthleteOn) await loadAthleteData(athleteRef, false);
                setPreviewSig(null);
                setPreviewNonce((n) => n + 1);
            }
        } finally {
            enviando.current = false;
            setSubmitting(false);
        }
    };

    // ── Descuento general: a qué líneas ────────────────────────────────────────
    const calcByRef = useMemo(() => {
        const m = new Map<string, LineCalc | MultiLineCalc>();
        (mode === 'single' ? single.lines : multiCalc.lines).forEach((l) => m.set(l.ref, l));
        return m;
    }, [mode, single.lines, multiCalc.lines]);
    const singleCalcByRef = useMemo(() => new Map(single.lines.map((l) => [l.ref, l])), [single.lines]);

    const globalTargets: GlobalTarget[] = mode === 'single'
        ? [
            ...charges.filter((c) => drafts[c.id]?.selected && !drafts[c.id]?.exonerate && !newAthleteOn).map((c) => ({
                ref: `pending:${c.id}`, label: c.concept, checked: drafts[c.id].inGlobal, share: singleCalcByRef.get(`pending:${c.id}`)?.generalShare,
            })),
            ...lines.map((l, i) => (l.exonerate ? null : {
                ref: `new:${i}`, label: l.concept || 'Cobro nuevo', checked: l.inGlobal, share: singleCalcByRef.get(`new:${i}`)?.generalShare,
            })).filter((x): x is NonNullable<typeof x> => !!x),
        ]
        : lines.map((l, i) => ({ ref: `new:${i}`, label: l.concept || 'Cobro', checked: l.inGlobal }));

    const toggleGlobalTarget = (ref: string, checked: boolean) => {
        const [kind, id] = ref.split(':');
        if (kind === 'pending') setDrafts((d) => ({ ...d, [id]: { ...d[id], inGlobal: checked } }));
        else setLines((ls) => ls.map((l, i) => (i === Number(id) ? { ...l, inGlobal: checked } : l)));
    };

    // Q-D2: al prender el general, por defecto solo las líneas SIN descuento propio
    const onGlobalChange = (next: GlobalDiscountDraft) => {
        if (next.enabled && !global.enabled) {
            setDrafts((d) => Object.fromEntries(Object.entries(d).map(([k, v]) => [k, { ...v, inGlobal: !v.discount }])));
            setLines((ls) => ls.map((l) => ({ ...l, inGlobal: !l.discount })));
        }
        setGlobal(next);
    };

    const useSeveralMonths = () => {
        setDrafts((d) => Object.fromEntries(Object.entries(d).map(([k, v]) => {
            const c = charges.find((x) => x.id === k);
            return [k, { ...v, inGlobal: !!v.selected && (c?.payment_category ?? 'mensualidad') === 'mensualidad' && !v.discount }];
        })));
        setGlobal({ ...emptyDiscount('varios_meses'), enabled: true });
    };

    // ── Datos para el bloque de pago ───────────────────────────────────────────
    const receiptCategory: PaymentChargeCategory | null = (() => {
        const firstPending = charges.find((c) => drafts[c.id]?.selected);
        if (firstPending) return chargeCategoryOf(firstPending.payment_category, firstPending.concept);
        return lines.find((l) => l.pay)?.category ?? null;
    })();
    const payerProfileId = selected ? (selected.athlete_type === 'adult' ? selected.id : selected.parent_id) : null;
    const payerName = selected ? (selected.athlete_type === 'adult' ? selected.full_name : selected.parent_name) : null;

    const switchMode = (m: 'single' | 'multi') => {
        if (m === mode) return;
        setMode(m);
        setPreview(null);
        setPreviewSig(null);
        setOverrides([]);
        if (m === 'multi') {
            setNewAthleteOn(false);
            setLines((ls) => (ls.length ? ls.map((l) => ({ ...l, pay: false, exonerate: null })) : [newLineDraft({ category: 'torneo', due_date: defaultDue, amount: null, pay: false })]));
        }
    };

    const locked = lockAthlete ?? !!initialAthleteId;
    const title = mode === 'multi' ? 'Cobros y pagos · varios atletas' : 'Cobros y pagos';
    const subtitle = mode === 'multi'
        ? `${schoolName ?? 'La escuela'} · genera los mismos cobros a varios atletas`
        : `${schoolName ?? 'La escuela'} · registra lo que pagó y crea cobros nuevos`;

    return (
        <Dialog open={open} onOpenChange={(o) => { if (!submitting) onOpenChange(o); }}>
            <DialogContent
                className="max-w-none sm:max-w-5xl w-full h-[100dvh] sm:h-[92vh] p-0 gap-0 flex flex-col overflow-hidden rounded-none sm:rounded-2xl"
                data-testid="cobros-y-pagos-modal"
            >
                <DialogHeader className="px-4 sm:px-6 pt-4 pb-3 border-b shrink-0 text-left">
                    <DialogTitle className="text-lg sm:text-xl font-bold pr-8">{title}</DialogTitle>
                    <DialogDescription className="text-xs sm:text-sm">{subtitle}</DialogDescription>
                    {!result && !locked && (
                        <ToggleGroup
                            type="single"
                            value={mode}
                            onValueChange={(v) => v && switchMode(v as 'single' | 'multi')}
                            className="justify-start pt-2"
                            aria-label="Modo"
                        >
                            <ToggleGroupItem value="single" className="h-8 text-xs gap-1.5" data-testid="cyp-mode-single"><User className="h-3.5 w-3.5" /> Un atleta</ToggleGroupItem>
                            <ToggleGroupItem value="multi" className="h-8 text-xs gap-1.5" data-testid="cyp-mode-multi"><Users className="h-3.5 w-3.5" /> Varios atletas</ToggleGroupItem>
                        </ToggleGroup>
                    )}
                </DialogHeader>

                {result ? (
                    <div className="flex-1 overflow-y-auto">
                        <ResultScreen
                            result={result}
                            onClose={() => onOpenChange(false)}
                            onViewOperation={onViewOperations ? () => { onOpenChange(false); onViewOperations(); } : undefined}
                            onAnnul={() => setAnnulOpen(true)}
                            onAnother={() => resetAll()}
                            onRetryHours={ventaDeHoras ? retryHours : undefined}
                            retryingHours={reintentandoHoras}
                            horasPorRegistrar={horasAparte ? { horas: horasAparte.horas, monto: horasAparte.monto } : undefined}
                            onRegisterHours={horasAparte ? registrarHorasAparte : undefined}
                        />
                        <AnnulBatchDialog batchId={result.batch_id} open={annulOpen} onOpenChange={setAnnulOpen} onDone={onSuccess} />
                    </div>
                ) : (
                    <>
                        <div className="flex-1 overflow-y-auto">
                            <div className="grid lg:grid-cols-[minmax(0,1fr)_20rem] min-w-0">
                                {/* ── Columna principal ── */}
                                <div className="p-4 sm:p-6 space-y-5 min-w-0">
                                    {mode === 'single' ? (
                                        <section className="space-y-2">
                                            <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Atleta</p>
                                            {newAthleteOn ? (
                                                <NewAthleteForm
                                                    value={newAthlete}
                                                    onChange={setNewAthlete}
                                                    serverDuplicates={serverDuplicates}
                                                    onCancel={() => { setNewAthleteOn(false); setServerDuplicates(undefined); }}
                                                    onUseExisting={(dup) => {
                                                        const found = athletes.find((a) => a.id === dup.id);
                                                        setNewAthleteOn(false);
                                                        setServerDuplicates(undefined);
                                                        if (found) setAthleteId(found.id);
                                                        else toast({ title: 'No está entre los activos', description: 'Ese atleta existe pero no tiene inscripción activa. Búscalo en Deportistas.' });
                                                    }}
                                                />
                                            ) : (
                                                <AthletePicker
                                                    athletes={athletes}
                                                    loading={loadingAthletes}
                                                    selectedId={athleteId}
                                                    onSelect={(id) => { setAthleteId(id); setOverrides([]); setHorasAparte(null); }}
                                                    locked={locked}
                                                    onNewAthlete={locked ? undefined : () => { setNewAthleteOn(true); setAthleteId(null); setCharges([]); setDrafts({}); setLines((ls) => ls.filter((l) => l.category !== 'mensualidad')); }}
                                                />
                                            )}
                                        </section>
                                    ) : (
                                        <section className="space-y-2">
                                            <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground">1. ¿A quiénes?</p>
                                            <MultiTargetPicker
                                                schoolId={schoolId}
                                                teams={teams.map((t) => ({ id: t.id, name: t.name }))}
                                                athletes={athletes}
                                                value={multi}
                                                onChange={setMulti}
                                                onResolved={setMultiResolved}
                                            />
                                        </section>
                                    )}

                                    {mode === 'single' && !newAthleteOn && athleteRef && (
                                        <section className="space-y-2">
                                            <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Cobros pendientes · marca los que cubre</p>
                                            <PendingChargesSection
                                                charges={charges}
                                                drafts={drafts}
                                                calcByRef={singleCalcByRef}
                                                paymentOn={payment.on}
                                                canDiscount={canDiscount}
                                                loading={loadingCharges}
                                                error={chargesError}
                                                onChange={(id, next) => setDrafts((d) => ({ ...d, [id]: next }))}
                                                severalMonthsMin={severalMonthsMin}
                                                onUseSeveralMonths={useSeveralMonths}
                                            />
                                        </section>
                                    )}

                                    <section className="space-y-2">
                                        <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground">
                                            {mode === 'multi' ? '2. ¿Qué se cobra? (igual para todos)' : 'Nuevos cobros'}
                                        </p>
                                        <NewChargeLines
                                            mode={mode}
                                            lines={lines}
                                            onChange={setLines}
                                            calcByRef={calcByRef}
                                            paymentOn={mode === 'single' && payment.on}
                                            canDiscount={canDiscount}
                                            canOverage={canOverage}
                                            suggestions={mode === 'single' && !newAthleteOn ? suggestions : null}
                                            defaultDue={defaultDue}
                                            minDue={today}
                                            noMonthly={mode === 'single' && newAthleteOn}
                                            skippedByLine={skippedByLine}
                                        />
                                        {mode === 'multi' && <p className="text-xs text-muted-foreground">Para registrar pagos, elige un solo atleta.</p>}
                                    </section>
                                </div>

                                {/* ── Columna lateral (en el celular va debajo) ── */}
                                <aside className="p-4 sm:p-6 lg:border-l bg-muted/20 space-y-4 min-w-0">
                                    {canDiscount && (
                                        <GlobalDiscount
                                            mode={mode}
                                            value={global}
                                            onChange={onGlobalChange}
                                            targets={globalTargets}
                                            onToggleTarget={toggleGlobalTarget}
                                            error={mode === 'single' ? single.generalError : null}
                                        />
                                    )}
                                    {mode === 'single' && horasAparte && (
                                        <div className="rounded-lg border border-primary/30 bg-primary/5 p-2.5 text-xs space-y-1.5" data-testid="cyp-horas-aparte">
                                            <p>
                                                <b>Horas aparte:</b> {formatHoras(horasAparte.horas)} h por {formatPesos(horasAparte.monto)}. Se registran en una segunda operación, con su propio pago, al terminar esta.
                                            </p>
                                            <Button type="button" variant="ghost" size="sm" className="h-7 text-xs px-2" onClick={volverAIncluirHoras}>Volver a incluirlas aquí</Button>
                                        </div>
                                    )}
                                    {mode === 'single' && (
                                        <PaymentBlock
                                            value={payment}
                                            onChange={(p) => {
                                                if (p.on !== payment.on) setLines((ls) => ls.map((l) => ({ ...l, pay: p.on })));
                                                setPayment(p);
                                            }}
                                            today={today}
                                            schoolId={schoolId}
                                            totalToPay={single.toPay.total}
                                            expectedAmount={single.toPay.total}
                                            paymentCategory={receiptCategory}
                                            payerProfileId={newAthleteOn ? null : payerProfileId}
                                            payerName={payerName}
                                            payerKind={selected?.athlete_type === 'adult' ? 'adult_athlete' : 'guardian'}
                                            invoicingEnabled={hasAddon('invoicing')}
                                            comprobante={comprobante}
                                            onSepararHoras={separarHoras}
                                        />
                                    )}
                                    {previewFresh && preview?.recent_duplicates?.length ? (
                                        <p className="rounded-lg border border-amber-500/40 bg-amber-50 dark:bg-amber-950/30 p-2 text-xs flex items-start gap-1.5" data-testid="cyp-aviso-duplicado">
                                            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0 text-amber-600" />
                                            Ojo: este mismo cobro ya se registró {textoCobroReciente(preview.recent_duplicates[0])}. Si lo confirmas te pediremos una confirmación más.
                                        </p>
                                    ) : null}
                                    <PreviewSummary
                                        mode={mode}
                                        local={mode === 'single'
                                            ? single
                                            : { toCreate: { n: multiCalc.estimatedRows, total: multiCalc.total }, toPay: { n: 0, total: 0 }, discountsTotal: multiCalc.discountsTotal, lateFeeWaived: 0, lateFeeIncluded: 0, exonerated: 0, listTotal: multiCalc.listTotal, perAthleteAmounts: multiCalc.hasPerAthleteAmounts }}
                                        preview={preview}
                                        fresh={previewFresh}
                                        loading={previewLoading}
                                        error={previewError}
                                        onRefresh={refreshPreview}
                                        overrides={overrides}
                                        onToggleOverride={(o, on) => setOverrides((list) => (on
                                            ? [...list.filter((x) => !(x.athlete === o.athlete && x.line_idx === o.line_idx)), o]
                                            : list.filter((x) => !(x.athlete === o.athlete && x.line_idx === o.line_idx))))}
                                        withoutPayer={mode === 'multi' ? multiResolved.withoutPayer : undefined}
                                        omitWithoutPayer={omitWithoutPayer}
                                        onOmitWithoutPayer={setOmitWithoutPayer}
                                    />
                                    <p className="text-[11px] text-muted-foreground">
                                        Queda registrado quién creó cada cobro, quién aplicó cada descuento y con qué motivo, y el valor original. Un doble clic no crea nada dos veces.
                                    </p>
                                </aside>
                            </div>
                        </div>

                        {/* ── Pie fijo: resumen + botón ── */}
                        <div className="border-t bg-background px-4 sm:px-6 py-3 shrink-0 space-y-2 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
                            {(toCreate > 0 || toPay > 0) && (
                                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs sm:text-sm">
                                    {toCreate > 0 && <span>Cobros nuevos: <b>{toCreate}</b>{(previewFresh ? (preview!.to_create?.total ?? preview!.total_amount) : (mode === 'single' ? single.toCreate.total : multiCalc.total)) > 0 ? ` · ${formatPesos(previewFresh ? (preview!.to_create?.total ?? preview!.total_amount) : (mode === 'single' ? single.toCreate.total : multiCalc.total))}` : ''}</span>}
                                    {toPay > 0 && <span>Se pagan: <b>{toPay}</b> · {formatPesos(previewFresh ? (preview!.to_pay?.total ?? single.toPay.total) : single.toPay.total)}</span>}
                                </div>
                            )}
                            {toCreate > 0 && (
                                <div className="flex items-center gap-2">
                                    <Checkbox id="cyp-notify" checked={notify} onCheckedChange={(v) => setNotify(v === true)} />
                                    <Label htmlFor="cyp-notify" className="text-xs font-normal">
                                        Las familias no reciben aviso de los cobros nuevos (lo ven en su app). Avisar por correo/WhatsApp
                                    </Label>
                                </div>
                            )}
                            {submitError && (
                                <p className="text-sm text-destructive flex items-start gap-1.5" role="alert">
                                    <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" /> {submitError}
                                </p>
                            )}
                            {duplicadoReciente && (
                                <div className="rounded-lg border border-amber-500/40 bg-amber-50 dark:bg-amber-950/30 p-3 text-sm space-y-2" role="alert" data-testid="cyp-duplicado-reciente">
                                    <p className="flex items-start gap-1.5">
                                        <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-amber-600" />
                                        <span>
                                            Este mismo cobro ya se registró {duplicadoReciente[0] ? textoCobroReciente(duplicadoReciente[0]) : 'hace pocos minutos'}. No se creó nada todavía: ¿es otro cobro y lo creamos igual?
                                        </span>
                                    </p>
                                    <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
                                        <Button variant="outline" size="sm" onClick={() => setDuplicadoReciente(null)} data-testid="cyp-duplicado-cancelar">No, revisar</Button>
                                        <Button size="sm" onClick={() => void submit(true)} disabled={submitting} data-testid="cyp-duplicado-confirmar">Sí, crear igual</Button>
                                    </div>
                                </div>
                            )}
                            <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-end gap-2">
                                {buttonReason && <p className="text-xs text-muted-foreground sm:mr-auto" data-testid="cyp-button-reason">{buttonReason}</p>}
                                <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>Cancelar</Button>
                                <Button onClick={() => void submit()} disabled={button.disabled || !!duplicadoReciente} className="min-w-[10rem]" data-testid="cyp-primary">
                                    {submitting && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}
                                    {button.label}
                                </Button>
                            </div>
                        </div>
                    </>
                )}
            </DialogContent>
        </Dialog>
    );
}
