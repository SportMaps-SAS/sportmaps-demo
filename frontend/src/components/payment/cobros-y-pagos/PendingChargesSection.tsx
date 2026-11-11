import { useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { tipoDeCobro } from '@/lib/tipoDeCobro';
import { formatDayCO } from '@/lib/dateUtils';
import {
    REASON_OPTIONS,
    formatPesos,
    isMensualidad,
    pendingBlockReason,
    type LineCalc,
    type PendingDraft,
} from '@/lib/cobrosYPagos';
import type { OpenCharge, ReasonCode } from '@/lib/api/chargeBatches';
import { DiscountControl } from './DiscountControl';
import { DiscountTags } from './DiscountTags';

const STATUS_LABEL: Record<string, string> = {
    pending: 'pendiente', overdue: 'vencida', partial: 'abono parcial', rejected: 'comprobante rechazado',
    failed: 'pago fallido', awaiting_approval: 'comprobante en revisión',
};

interface PendingChargesSectionProps {
    charges: OpenCharge[];
    drafts: Record<string, PendingDraft>;
    calcByRef: Map<string, LineCalc>;
    paymentOn: boolean;
    canDiscount: boolean;
    loading?: boolean;
    error?: string | null;
    onChange: (paymentId: string, next: PendingDraft) => void;
    /** Sugerencia «varios meses» cuando se marcan ≥ N mensualidades (Q-D3). */
    severalMonthsMin?: number | null;
    onUseSeveralMonths?: () => void;
}

/**
 * «Cobros pendientes» (§10.2): casillas, desglose, saldo, «Pagar», abono vs.
 * cerrar, condonar recargo y descuento por línea. Lo que tiene comprobante en
 * revisión o pago en línea en curso sale deshabilitado con su motivo (Q22).
 */
export function PendingChargesSection({
    charges, drafts, calcByRef, paymentOn, canDiscount, loading, error, onChange, severalMonthsMin, onUseSeveralMonths,
}: PendingChargesSectionProps) {
    const [openDiscount, setOpenDiscount] = useState<Record<string, boolean>>({});

    if (loading) {
        return <p className="text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Cargando cobros pendientes…</p>;
    }
    if (error) return <p className="text-sm text-destructive">{error}</p>;
    if (charges.length === 0) return <p className="text-sm text-muted-foreground">No tiene cobros pendientes.</p>;

    const monthsMarked = charges.filter((c) => drafts[c.id]?.selected && isMensualidad(c.payment_category)).length;

    return (
        <div className="space-y-2" data-testid="cyp-pending">
            {charges.map((c) => {
                const d = drafts[c.id];
                if (!d) return null;
                const calc = calcByRef.get(`pending:${c.id}`);
                const blocked = pendingBlockReason(c);
                const late = Number(c.late_fee_amount) || 0;
                const paid = Number(c.amount_paid) || 0;
                const list = c.list_amount != null ? Number(c.list_amount) : Number(c.amount) - late;
                const balanceNow = Number(c.balance ?? (Number(c.amount) - paid - (Number(c.early_payment_discount_applied) || 0)));
                const set = (patch: Partial<PendingDraft>) => onChange(c.id, { ...d, ...patch });
                const showDiscount = openDiscount[c.id] || !!d.discount || !!d.exonerate;
                const mensual = isMensualidad(c.payment_category);
                const pronto = c.suggestions?.pronto_pago;
                const canSuggestPronto = canDiscount && pronto && !(Number(c.early_payment_discount_applied) > 0) && !d.discount;
                const payValue = d.payAmount ?? calc?.balance ?? balanceNow;
                const partialPay = paymentOn && calc && calc.payAmount > 0 && calc.payAmount < calc.balance;

                return (
                    <div
                        key={c.id}
                        className={cn('rounded-xl border p-3 space-y-2', d.selected && !blocked ? 'border-primary/50 bg-primary/5' : 'bg-background', blocked && 'opacity-70')}
                        data-testid={`cyp-pending-${c.id}`}
                    >
                        <div className="flex items-start gap-3">
                            <Checkbox
                                id={`pend-${c.id}`}
                                checked={d.selected && !blocked}
                                disabled={!!blocked}
                                onCheckedChange={(v) => set({ selected: v === true })}
                                className="mt-1"
                                aria-label={`Incluir ${c.concept}`}
                            />
                            <div className="flex-1 min-w-0 space-y-1">
                                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                                    <Label htmlFor={`pend-${c.id}`} className="font-semibold leading-snug cursor-pointer">
                                        {c.concept}
                                        <span className={cn('ml-2 text-xs font-medium', c.status === 'overdue' ? 'text-orange-600' : 'text-muted-foreground')}>
                                            · {STATUS_LABEL[c.status] ?? c.status}
                                        </span>
                                    </Label>
                                    <span className="text-sm tabular-nums">
                                        Saldo <b>{formatPesos(d.selected && calc ? calc.balance : balanceNow)}</b>
                                        {d.selected && calc && calc.balance !== balanceNow && (
                                            <span className="ml-1 text-xs text-muted-foreground line-through">{formatPesos(balanceNow)}</span>
                                        )}
                                    </span>
                                </div>
                                <p className="text-xs text-muted-foreground">
                                    <Badge variant="outline" className="mr-1.5 text-[10px] py-0">{mensual ? 'Mensualidad' : `Pago único · ${tipoDeCobro(c).etiqueta}`}</Badge>
                                    {c.due_date ? `Vence ${formatDayCO(c.due_date)} · ` : ''}
                                    Valor {formatPesos(list)}
                                    {Number(c.discount_amount) > 0 ? ` − descuentos ${formatPesos(Number(c.discount_amount))}` : ''}
                                    {late > 0 ? ` + recargo ${formatPesos(late)}` : ''}
                                    {paid > 0 ? ` · abonado ${formatPesos(paid)}` : ''}
                                </p>
                                {late > 0 && (
                                    <div className="flex items-start gap-2 rounded-lg border border-amber-400/40 bg-amber-500/10 p-2" data-testid={`cyp-late-${c.id}`}>
                                        <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5 text-amber-500" />
                                        <div className="space-y-0.5 text-xs text-amber-700 dark:text-amber-400">
                                            <p className="font-bold">En mora: este cobro trae recargo</p>
                                            <p className="tabular-nums">
                                                {mensual ? 'Mensualidad' : 'Valor del cobro'} {formatPesos(Math.max(0, Number(c.amount) - late))} + recargo por mora {formatPesos(late)} = <b>{formatPesos(Number(c.amount))}</b>
                                                {d.selected && d.waive.enabled ? ' · recargo condonado' : ''}
                                            </p>
                                            {paid > 0 && <p>Ya abonado {formatPesos(paid)} · se cobra el saldo {formatPesos(balanceNow)}</p>}
                                        </div>
                                    </div>
                                )}
                                {blocked && (
                                    <p className="text-xs text-amber-700 dark:text-amber-400 flex items-start gap-1">
                                        <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" /> {blocked}
                                    </p>
                                )}
                                {c.requires_review && !blocked && (
                                    <p className="text-xs text-amber-700 dark:text-amber-400">Un intento con tarjeta fue rechazado; al registrar el pago aquí el cobro se destraba.</p>
                                )}
                                <DiscountTags tags={calc?.tags ?? []} ratio={calc?.discountRatio} over50={d.selected && calc?.over50} />
                            </div>
                        </div>

                        {d.selected && !blocked && (
                            <div className="pl-7 space-y-2">
                                {paymentOn && !d.exonerate && (
                                    <div className="flex flex-wrap items-center gap-2">
                                        <Label htmlFor={`pay-${c.id}`} className="text-xs font-semibold">Pagar</Label>
                                        <Input
                                            id={`pay-${c.id}`}
                                            type="number"
                                            inputMode="numeric"
                                            min={0}
                                            className="h-9 w-36 text-sm tabular-nums"
                                            value={payValue}
                                            onChange={(e) => set({ payAmount: e.target.value === '' ? 0 : Number(e.target.value) })}
                                        />
                                        {d.payAmount != null && calc && d.payAmount !== calc.balance && (
                                            <Button type="button" variant="link" size="sm" className="h-7 px-1 text-xs" onClick={() => set({ payAmount: null })}>
                                                Todo el saldo
                                            </Button>
                                        )}
                                    </div>
                                )}
                                {partialPay && calc && (
                                    <RadioGroup
                                        value={d.closeMode}
                                        onValueChange={(v) => set({ closeMode: v as PendingDraft['closeMode'] })}
                                        className="grid gap-1.5"
                                        aria-label="Qué pasa con la diferencia"
                                    >
                                        <div className="flex items-center gap-2">
                                            <RadioGroupItem id={`abono-${c.id}`} value="abono" />
                                            <Label htmlFor={`abono-${c.id}`} className="text-xs font-normal">
                                                Abono — queda debiendo {formatPesos(calc.balance - calc.payAmount)}
                                            </Label>
                                        </div>
                                        {canDiscount && (
                                            <div className="flex items-center gap-2">
                                                <RadioGroupItem id={`cerrar-${c.id}`} value="cerrar" />
                                                <Label htmlFor={`cerrar-${c.id}`} className="text-xs font-normal">
                                                    Cerrar el cobro — los {formatPesos(calc.balance - calc.payAmount)} son descuento
                                                </Label>
                                            </div>
                                        )}
                                    </RadioGroup>
                                )}
                                {partialPay && d.closeMode === 'cerrar' && !d.discount && (
                                    <div className="grid gap-2 sm:grid-cols-2">
                                        <Select
                                            value={d.closeReason.reason_code || undefined}
                                            onValueChange={(v) => set({ closeReason: { ...d.closeReason, reason_code: v as ReasonCode } })}
                                        >
                                            <SelectTrigger className="h-9 text-sm" aria-label="Motivo del cierre"><SelectValue placeholder="¿Por qué se cierra por menos?" /></SelectTrigger>
                                            <SelectContent>
                                                {REASON_OPTIONS.filter((o) => o.value !== 'condonacion_mora').map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                                            </SelectContent>
                                        </Select>
                                        {d.closeReason.reason_code === 'otro' && (
                                            <Input
                                                aria-label="Motivo del cierre"
                                                className="h-9 text-sm"
                                                placeholder="¿Cuál motivo?"
                                                value={d.closeReason.reason_text}
                                                onChange={(e) => set({ closeReason: { ...d.closeReason, reason_text: e.target.value } })}
                                            />
                                        )}
                                    </div>
                                )}

                                {canDiscount && (
                                    <div className="flex flex-wrap gap-1.5">
                                        {!showDiscount && (
                                            <Button type="button" variant="outline" size="sm" className="h-8 text-xs" onClick={() => setOpenDiscount((o) => ({ ...o, [c.id]: true }))}>
                                                Descuento
                                            </Button>
                                        )}
                                        {late > 0 && !d.exonerate && (
                                            <Button
                                                type="button"
                                                variant={d.waive.enabled ? 'secondary' : 'outline'}
                                                size="sm"
                                                className="h-8 text-xs"
                                                aria-pressed={d.waive.enabled}
                                                onClick={() => set({ waive: { ...d.waive, enabled: !d.waive.enabled, reason_text: d.waive.reason_text || 'Condonación de mora' } })}
                                            >
                                                {d.waive.enabled ? 'Recargo condonado' : `Condonar recargo (${formatPesos(late)})`}
                                            </Button>
                                        )}
                                        {canSuggestPronto && pronto && (
                                            <Button
                                                type="button" variant="ghost" size="sm" className="h-8 text-xs text-violet-700 dark:text-violet-300"
                                                onClick={() => {
                                                    set({ discount: { basis: 'porcentaje', value: pronto.pct, reason_code: 'pronto_pago', reason_text: '' } });
                                                    setOpenDiscount((o) => ({ ...o, [c.id]: true }));
                                                }}
                                            >
                                                Sugerencia: pronto pago {pronto.pct} %{pronto.valid_until ? ` hasta el ${formatDayCO(pronto.valid_until)}` : ''} · Usar
                                            </Button>
                                        )}
                                    </div>
                                )}

                                {canDiscount && d.waive.enabled && late > 0 && (
                                    <div className="grid gap-2 sm:grid-cols-2 rounded-lg border border-orange-300/60 bg-orange-50/50 dark:bg-orange-950/20 p-2">
                                        <div className="space-y-1">
                                            <Label htmlFor={`waive-${c.id}`} className="text-xs">Cuánto se condona</Label>
                                            <Input
                                                id={`waive-${c.id}`}
                                                type="number"
                                                inputMode="numeric"
                                                className="h-9 text-sm"
                                                placeholder={`Todo (${formatPesos(late)})`}
                                                value={d.waive.value ?? ''}
                                                onChange={(e) => set({ waive: { ...d.waive, value: e.target.value === '' ? null : Number(e.target.value) } })}
                                            />
                                        </div>
                                        <div className="space-y-1">
                                            <Label htmlFor={`waive-r-${c.id}`} className="text-xs">Motivo</Label>
                                            <Input
                                                id={`waive-r-${c.id}`}
                                                className="h-9 text-sm"
                                                value={d.waive.reason_text}
                                                onChange={(e) => set({ waive: { ...d.waive, reason_text: e.target.value } })}
                                            />
                                        </div>
                                    </div>
                                )}

                                {canDiscount && showDiscount && (
                                    <DiscountControl
                                        idPrefix={`pend-${c.id}`}
                                        value={d.discount}
                                        onChange={(next) => {
                                            set({ discount: next });
                                            if (!next) setOpenDiscount((o) => ({ ...o, [c.id]: false }));
                                        }}
                                        effect={calc?.lineDiscount}
                                        resulting={calc ? calc.amountAfter : undefined}
                                        exonerate={d.exonerate}
                                        onExonerateChange={paid > 0 ? undefined : (next) => {
                                            set({ exonerate: next, discount: null });
                                            if (!next) setOpenDiscount((o) => ({ ...o, [c.id]: false }));
                                        }}
                                        exonerateHint={mensual ? 'beca del mes: queda pagada en $0 y cuenta para la vigencia' : 'el cobro se anula'}
                                    />
                                )}
                                {calc?.errors.map((e, i) => <p key={i} className="text-xs text-destructive" role="alert">{e}</p>)}
                            </div>
                        )}
                    </div>
                );
            })}
            {canDiscount && severalMonthsMin != null && monthsMarked >= severalMonthsMin && onUseSeveralMonths && (
                <p className="text-xs text-violet-700 dark:text-violet-300">
                    Marcaste {monthsMarked} mensualidades.{' '}
                    <Button type="button" variant="link" size="sm" className="h-auto p-0 text-xs" onClick={onUseSeveralMonths}>
                        ¿Descuento por pagar varios meses juntos?
                    </Button>
                </p>
            )}
        </div>
    );
}
