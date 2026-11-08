import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, Loader2, RefreshCw, Undo2, XCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { adjustmentLabel, formatPesos, isMensualidad } from '@/lib/cobrosYPagos';
import { todayColombia } from '@/lib/dateUtils';
import { juntarPorAtleta } from '@/lib/pagosRecibidosOrden';
import { TipoDeCobroBadge } from '@/components/payments/TipoDeCobroBadge';
import {
    chargeBatchesApi,
    toChargeBatchError,
    type AdjustmentTag,
    type ChargeBatchDetail,
    type ChargeBatchSummary,
    type PaymentAdjustmentReportRow,
} from '@/lib/api/chargeBatches';

const ANNULLABLE = ['pending', 'overdue', 'rejected', 'failed'];

const STATUS_BADGE: Record<string, { label: string; className: string }> = {
    created: { label: 'Vigente', className: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/30 dark:text-emerald-300' },
    partially_annulled: { label: 'Anulado en parte', className: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/30 dark:text-amber-300' },
    annulled: { label: 'Anulado', className: 'bg-muted text-muted-foreground' },
};

const ROW_STATUS: Record<string, string> = {
    pending: 'Pendiente', overdue: 'Vencido', paid: 'Pagado', partial: 'Abono', cancelled: 'Anulado',
    awaiting_approval: 'En revisión', rejected: 'Rechazado', failed: 'Fallido', glosado: 'Glosado',
};

const fmtDate = (iso: string) => {
    try {
        return new Intl.DateTimeFormat('es-CO', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Bogota' }).format(new Date(iso));
    } catch {
        return iso;
    }
};

const reportToTag = (i: PaymentAdjustmentReportRow): AdjustmentTag => ({
    id: i.id, origin: i.origin, kind: i.kind, reason_code: i.reason_code, basis: i.basis ?? null,
    pct: i.pct ?? null, amount: i.amount, label: i.label, reverted: i.reverted,
});

const who = (b: ChargeBatchSummary) => b.created_by?.name ?? b.created_by_name ?? '—';
const target = (b: ChargeBatchSummary) => b.target_label ?? b.target?.label ?? (b.mode === 'single' ? 'Un atleta' : 'Varios atletas');

// ── Anular lote (Q12) ─────────────────────────────────────────────────────────

export function AnnulBatchDialog({ batchId, open, onOpenChange, onDone }: {
    batchId: string | null;
    open: boolean;
    onOpenChange: (o: boolean) => void;
    onDone?: () => void;
}) {
    const { toast } = useToast();
    const [detail, setDetail] = useState<ChargeBatchDetail | null>(null);
    const [loading, setLoading] = useState(false);
    const [reason, setReason] = useState('');
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        if (!batchId) return;
        setLoading(true);
        setError(null);
        try {
            setDetail(await chargeBatchesApi.get(batchId));
        } catch (e) {
            setError(toChargeBatchError(e).message);
        } finally {
            setLoading(false);
        }
    }, [batchId]);

    useEffect(() => { if (open) { setReason(''); load(); } }, [open, load]);

    const annullable = (detail?.rows ?? []).filter((r) => ANNULLABLE.includes(r.status));
    const kept = (detail?.rows ?? []).filter((r) => !ANNULLABLE.includes(r.status) && r.status !== 'cancelled');
    // El BFF da el conteo exacto que la RPC exige como expected_count (Q12); si no, se cuenta aquí.
    const annullableCount = detail?.annul_preview?.annullable_count ?? annullable.length;
    const annullableTotal = detail?.annul_preview?.annullable_total ?? annullable.reduce((a, r) => a + (Number(r.amount) || 0), 0);
    const keptCount = kept.length;
    const hasMonthly = annullable.some((r) => isMensualidad(r.payment_category));
    const reasonOk = reason.trim().length >= 3 && reason.trim().length <= 300;

    const confirm = async () => {
        if (!batchId || !reasonOk) return;
        setSaving(true);
        setError(null);
        try {
            const r = await chargeBatchesApi.annul(batchId, { reason: reason.trim(), expected_count: annullableCount });
            toast({ title: 'Lote anulado', description: `Se anularon ${r.annulled ?? annullableCount} cobros${r.kept?.length ? `; ${r.kept.length} no se tocaron` : ''}.` });
            onOpenChange(false);
            onDone?.();
        } catch (e) {
            const err = toChargeBatchError(e);
            setError(err.message);
            if (err.code === 'ANNUL_STALE') load();
        } finally {
            setSaving(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>Anular lote</DialogTitle>
                    <DialogDescription>Solo se anula lo que nadie ha pagado. Lo pagado, en revisión o facturado no se toca.</DialogDescription>
                </DialogHeader>
                {loading ? (
                    <p className="text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Revisando el lote…</p>
                ) : detail ? (
                    <div className="space-y-3 text-sm">
                        <p data-testid="annul-count">
                            Se anularán <b>{annullableCount}</b> {annullableCount === 1 ? 'cobro pendiente' : 'cobros pendientes'} por <b>{formatPesos(annullableTotal)}</b>.
                            {keptCount > 0 && <> {keptCount} {keptCount === 1 ? 'ya pagado o en revisión no se toca' : 'ya pagados o en revisión no se tocan'}.</>}
                        </p>
                        {hasMonthly && <p className="text-xs text-amber-700 dark:text-amber-400">Las mensualidades anuladas se volverán a generar con el ciclo normal del mes.</p>}
                        <div className="space-y-1">
                            <Label htmlFor="annul-reason">Motivo *</Label>
                            <Textarea id="annul-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} rows={2} />
                        </div>
                    </div>
                ) : null}
                {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
                <DialogFooter className="gap-2">
                    <Button variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
                    <Button variant="destructive" disabled={!detail || annullableCount === 0 || !reasonOk || saving} onClick={confirm}>
                        {saving && <Loader2 className="h-4 w-4 animate-spin mr-1" />} Anular {annullableCount}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

// ── Quitar descuento (§7.5) ───────────────────────────────────────────────────

function RevertAdjustmentDialog({ adjustment, onOpenChange, onDone }: {
    adjustment: AdjustmentTag | null;
    onOpenChange: (o: boolean) => void;
    onDone: () => void;
}) {
    const { toast } = useToast();
    const [reason, setReason] = useState('');
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => { setReason(''); setError(null); }, [adjustment]);
    const ok = reason.trim().length >= 3;
    const go = async () => {
        if (!adjustment?.id || !ok) return;
        setSaving(true);
        try {
            await chargeBatchesApi.revertAdjustment(adjustment.id, reason.trim());
            toast({ title: 'Descuento quitado', description: 'El cobro volvió a su valor anterior.' });
            onOpenChange(false);
            onDone();
        } catch (e) {
            setError(toChargeBatchError(e).message);
        } finally {
            setSaving(false);
        }
    };
    return (
        <Dialog open={!!adjustment} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>Quitar descuento</DialogTitle>
                    <DialogDescription>
                        {adjustment ? `${adjustmentLabel(adjustment)}: el cobro sube ${formatPesos(adjustment.amount)}. Solo se puede si nadie ha pagado el cobro.` : ''}
                    </DialogDescription>
                </DialogHeader>
                <div className="space-y-1">
                    <Label htmlFor="revert-reason">Motivo *</Label>
                    <Textarea id="revert-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} rows={2} />
                </div>
                {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
                <DialogFooter className="gap-2">
                    <Button variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
                    <Button disabled={!ok || saving} onClick={go}>{saving && <Loader2 className="h-4 w-4 animate-spin mr-1" />} Quitar descuento</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

// ── Pestaña ───────────────────────────────────────────────────────────────────

/**
 * Pagos → «Operaciones» (§10.5): cada confirmación de «Cobros y pagos» con
 * quién, a quién, cobros creados, pagos registrados, descuentos y total;
 * «Anular lote» (solo lo creado y no pagado, Q12) y, por cobro, «Quitar
 * descuento». El contador la ve sin acciones (Q19).
 */
export function OperacionesTab({ canManage }: { canManage: boolean }) {
    const [items, setItems] = useState<ChargeBatchSummary[]>([]);
    const [cursor, setCursor] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [withDiscounts, setWithDiscounts] = useState(false);
    const [expanded, setExpanded] = useState<string | null>(null);
    const [details, setDetails] = useState<Record<string, ChargeBatchDetail>>({});
    const [annulId, setAnnulId] = useState<string | null>(null);
    const [revert, setRevert] = useState<AdjustmentTag | null>(null);
    const [batchAdj, setBatchAdj] = useState<Record<string, PaymentAdjustmentReportRow[]>>({});
    const [report, setReport] = useState<PaymentAdjustmentReportRow[] | null>(null);
    const [reportLoading, setReportLoading] = useState(false);

    const load = useCallback(async (reset: boolean, from: string | null) => {
        setLoading(true);
        setError(null);
        try {
            const page = await chargeBatchesApi.list({ cursor: reset ? null : from });
            setItems((prev) => (reset ? page.items : [...prev, ...page.items]));
            setCursor(page.next_cursor);
        } catch (e) {
            setError(toChargeBatchError(e).message);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { load(true, null); }, [load]);

    const shown = withDiscounts ? items.filter((b) => b.discount_total > 0 || b.late_fee_waived_total > 0) : items;

    /** Ajustes de un lote (el detalle del BFF no los trae): del informe, filtrados por lote. */
    const loadBatchAdjustments = async (b: ChargeBatchSummary) => {
        try {
            const r = await chargeBatchesApi.adjustmentsReport({ from: b.created_at.slice(0, 10), to: todayColombia() });
            setBatchAdj((x) => ({ ...x, [b.id]: r.items.filter((i) => i.charge_batch_id === b.id) }));
        } catch {
            setBatchAdj((x) => ({ ...x, [b.id]: [] }));
        }
    };

    const toggle = async (id: string) => {
        if (expanded === id) { setExpanded(null); return; }
        setExpanded(id);
        const b = items.find((x) => x.id === id);
        if (b && !batchAdj[id] && (b.discount_total > 0 || b.late_fee_waived_total > 0)) loadBatchAdjustments(b);
        if (!details[id]) {
            try {
                const d = await chargeBatchesApi.get(id);
                setDetails((x) => ({ ...x, [id]: d }));
            } catch (e) {
                setError(toChargeBatchError(e).message);
            }
        }
    };

    const reloadDetail = async (id: string) => {
        try {
            const d = await chargeBatchesApi.get(id);
            setDetails((x) => ({ ...x, [id]: d }));
        } catch { /* se ve al reabrir */ }
    };

    const loadReport = async () => {
        setReportLoading(true);
        try {
            const now = new Date();
            const from = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
            const r = await chargeBatchesApi.adjustmentsReport({ from });
            setReport(r.items ?? []);
        } catch (e) {
            setError(toChargeBatchError(e).message);
        } finally {
            setReportLoading(false);
        }
    };

    return (
        <Card data-testid="operaciones-tab">
            <CardHeader className="pb-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                        <CardTitle className="text-base">Operaciones</CardTitle>
                        <CardDescription>
                            Solo lo que el equipo hizo desde el modal «Cobros y pagos»: qué cobro creó, qué pago
                            registró y qué descontó. Lo que la familia paga directo (en línea, QR, WhatsApp) no
                            nace acá — eso está en Pagos recibidos, con todo lo que entró sin importar el origen.
                        </CardDescription>
                    </div>
                    <div className="flex items-center gap-3">
                        <div className="flex items-center gap-2">
                            <Switch id="op-disc" checked={withDiscounts} onCheckedChange={setWithDiscounts} />
                            <Label htmlFor="op-disc" className="text-xs">Con descuentos</Label>
                        </div>
                        <Button variant="outline" size="sm" onClick={() => load(true, null)} disabled={loading}>
                            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
                        </Button>
                    </div>
                </div>
            </CardHeader>
            <CardContent className="space-y-2">
                {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
                {!loading && shown.length === 0 && !error && <p className="text-sm text-muted-foreground">{withDiscounts ? 'Ninguna operación con descuentos en lo cargado.' : 'Todavía no hay operaciones.'}</p>}
                {shown.map((b) => {
                    const st = STATUS_BADGE[b.status] ?? STATUS_BADGE.created;
                    const d = details[b.id];
                    return (
                        <div key={b.id} className="rounded-xl border p-3 space-y-2" data-testid={`op-${b.id}`}>
                            <div className="flex flex-wrap items-start justify-between gap-2">
                                <div className="min-w-0">
                                    <p className="text-sm font-semibold truncate">{target(b)}</p>
                                    <p className="text-xs text-muted-foreground">{fmtDate(b.created_at)} · {who(b)}</p>
                                </div>
                                <Badge variant="outline" className={st.className}>{st.label}</Badge>
                            </div>
                            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                                <span>Cobros creados <b className="block text-sm">{b.rows_created}{b.rows_created ? ` · ${formatPesos(b.total_amount)}` : ''}</b></span>
                                <span>Pagos registrados <b className="block text-sm">{b.payments_registered}{b.paid_total ? ` · ${formatPesos(b.paid_total)}` : ''}</b></span>
                                <span>Descuentos <b className="block text-sm text-violet-700 dark:text-violet-300">{b.discount_total ? `−${formatPesos(b.discount_total)}` : '—'}</b></span>
                                <span>Recargo condonado <b className="block text-sm">{b.late_fee_waived_total ? `−${formatPesos(b.late_fee_waived_total)}` : '—'}</b></span>
                            </div>
                            {b.annul_reason && <p className="text-xs text-muted-foreground">Anulado: {b.annul_reason}</p>}
                            <div className="flex flex-wrap gap-2">
                                <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={() => toggle(b.id)}>
                                    Ver detalle <ChevronDown className={`h-3.5 w-3.5 ml-1 transition-transform ${expanded === b.id ? 'rotate-180' : ''}`} />
                                </Button>
                                {canManage && b.status !== 'annulled' && b.rows_created > 0 && (
                                    <Button variant="ghost" size="sm" className="h-8 text-xs text-destructive" onClick={() => setAnnulId(b.id)}>
                                        <XCircle className="h-3.5 w-3.5 mr-1" /> Anular lote
                                    </Button>
                                )}
                            </div>
                            {expanded === b.id && (
                                <div className="rounded-lg bg-muted/30 p-2 space-y-1.5">
                                    {!d ? <p className="text-xs text-muted-foreground flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" /> Cargando…</p> : juntarPorAtleta(d.rows, (r) => r.athlete_name).map((r) => (
                                        <div key={r.payment_id} className="text-xs space-y-1 border-b last:border-0 pb-1.5">
                                            <div className="flex flex-wrap justify-between gap-2">
                                                <span className="inline-flex flex-wrap items-center gap-1.5 min-w-0">
                                                    {/* Qué es el cobro (Mensualidad, Clínica, Torneo…); el concepto va al lado. */}
                                                    <TipoDeCobroBadge payment={r} conServicio={false} />
                                                    <span>{r.athlete_name ? <><b>{r.athlete_name}</b> · </> : null}{r.concept}</span>
                                                </span>
                                                <span className="tabular-nums">{formatPesos(r.amount)} · {ROW_STATUS[r.status] ?? r.status}</span>
                                            </div>
                                            {[...(r.adjustments ?? []), ...(batchAdj[b.id] ?? []).filter((x) => x.payment_id === r.payment_id).map(reportToTag)]
                                                .filter((a) => !a.reverted && a.kind !== 'reversion').map((a, i) => (
                                                <div key={a.id ?? i} className="flex flex-wrap items-center justify-between gap-2 pl-2">
                                                    <span className="text-violet-700 dark:text-violet-300">{adjustmentLabel(a)}</span>
                                                    {canManage && a.id && a.origin === 'modal' && ANNULLABLE.concat('partial').includes(r.status) && (
                                                        <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => setRevert(a)}>
                                                            <Undo2 className="h-3 w-3 mr-1" /> Quitar descuento
                                                        </Button>
                                                    )}
                                                </div>
                                            ))}
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    );
                })}
                {cursor && (
                    <Button variant="outline" size="sm" className="w-full" onClick={() => load(false, cursor)} disabled={loading}>
                        {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Cargar más'}
                    </Button>
                )}

                <div className="pt-2 border-t space-y-2">
                    <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={loadReport} disabled={reportLoading}>
                        {reportLoading ? 'Cargando…' : 'Informe de descuentos de este mes'}
                    </Button>
                    {report && (report.length === 0 ? <p className="text-xs text-muted-foreground">Sin descuentos este mes.</p> : (
                        <div className="max-h-64 overflow-y-auto space-y-1 text-xs">
                            {juntarPorAtleta(report, (r) => r.athlete_name).map((r) => (
                                <p key={r.id}>
                                    {fmtDate(r.created_at)} · <b>{r.athlete_name}</b> · {r.concept} · {r.label ?? adjustmentLabel({ origin: r.origin, kind: r.kind, reason_code: r.reason_code, amount: r.amount, basis: r.basis ?? 'valor', pct: r.pct })}{r.reverted ? ' (quitado)' : ''}
                                    {r.created_by_name ? ` · ${r.created_by_name}` : ''}
                                </p>
                            ))}
                        </div>
                    ))}
                </div>
            </CardContent>
            <AnnulBatchDialog
                batchId={annulId}
                open={!!annulId}
                onOpenChange={(o) => { if (!o) setAnnulId(null); }}
                onDone={() => { const id = annulId; load(true, null); if (id) reloadDetail(id); }}
            />
            <RevertAdjustmentDialog
                adjustment={revert}
                onOpenChange={(o) => { if (!o) setRevert(null); }}
                onDone={() => {
                    if (expanded) {
                        reloadDetail(expanded);
                        const b = items.find((x) => x.id === expanded);
                        if (b) loadBatchAdjustments(b);
                    }
                    load(true, null);
                }}
            />
        </Card>
    );
}
