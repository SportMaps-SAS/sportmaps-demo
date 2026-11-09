import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { CHARGE_CATEGORY_LABEL, type PaymentChargeCategory } from '@/lib/payment-accounts';
import { MANUAL_CHARGE_CATEGORY_OPTIONS } from '@/lib/manualPaymentCharge';
import { currentPeriodBogota, formatPeriodLabel, parsePeriodKey, periodKey, shiftPeriod } from '@/lib/paymentPeriod';
import { formatPesos, monthsFromToday, newLineDraft, type LineCalc, type MultiLineCalc, type NewLineDraft } from '@/lib/cobrosYPagos';
import type { ChargeSuggestions } from '@/lib/api/chargeBatches';
import { DiscountControl } from './DiscountControl';
import { HorasAdicionalesLine } from './HorasAdicionalesLine';
import { DiscountTags } from './DiscountTags';

interface NewChargeLinesProps {
    mode: 'single' | 'multi';
    lines: NewLineDraft[];
    onChange: (lines: NewLineDraft[]) => void;
    calcByRef: Map<string, LineCalc | MultiLineCalc>;
    paymentOn: boolean;
    canDiscount: boolean;
    canOverage: boolean;
    suggestions?: ChargeSuggestions | null;
    defaultDue: string;
    minDue: string;
    /** Atleta nuevo: sin plan, sin mensualidad (§16.2). */
    noMonthly?: boolean;
    /** Líneas que la vista previa omitió (índice → motivo en texto), p. ej. «ya tiene la mensualidad de ese mes». */
    skippedByLine?: Map<number, string>;
}

/** Mes con mensualidad: hasta 12 atrás y 3 adelante (Q4). */
function monthOptions() {
    const today = currentPeriodBogota();
    const out = [];
    for (let i = -12; i <= 3; i++) out.push(shiftPeriod(today, i));
    return out;
}

/**
 * «+ Nuevo cobro» (§10.2): N líneas con tipo, detalle, valor, vence, descuento,
 * nota y —con «Ya lo pagaron»— la casilla «Pagar». En el celular cada línea se
 * apila (tipo / detalle / valor+vence / descuento / nota).
 */
export function NewChargeLines({
    mode, lines, onChange, calcByRef, paymentOn, canDiscount, canOverage, suggestions, defaultDue, minDue, noMonthly, skippedByLine,
}: NewChargeLinesProps) {
    const [openDiscount, setOpenDiscount] = useState<Record<string, boolean>>({});
    const today = currentPeriodBogota();
    const months = monthOptions();

    const categories = MANUAL_CHARGE_CATEGORY_OPTIONS.filter((o) =>
        (o.value !== 'excedente' || (canOverage && mode === 'single'))
        && (o.value !== 'mensualidad' || !noMonthly));

    const update = (idx: number, patch: Partial<NewLineDraft>) => {
        const next = [...lines];
        next[idx] = { ...next[idx], ...patch };
        onChange(next);
    };

    const suggestedMonthly = suggestions?.suggested_monthly?.amount ?? null;
    const primaryEnrollment = suggestions?.enrollments?.find((e) => e.is_primary) ?? suggestions?.enrollments?.[0] ?? null;

    const changeCategory = (idx: number, category: PaymentChargeCategory) => {
        const l = lines[idx];
        const patch: Partial<NewLineDraft> = { category, concept: CHARGE_CATEGORY_LABEL[category], overage_charge_id: null, extra_hours: null, horas_modo: null };
        if (category === 'excedente') {
            // «Horas adicionales» puede ser cobrar lo que ya usó o vender por adelantado: no se elige
            // por el usuario. La línea nace sin modo y HorasAdicionalesLine lo pide (sin banco de horas
            // pasa sola a «Ya las usó»).
            patch.period = null;
            patch.enrollment_id = null;
            if (l.category === 'mensualidad') patch.amount = null;
        } else if (category === 'mensualidad') {
            const p = suggestions?.next_period ?? today;
            patch.period = p;
            patch.concept = `Mensualidad ${formatPeriodLabel(p.year, p.month)}`;
            patch.enrollment_id = primaryEnrollment?.enrollment_id ?? null;
            patch.amount = mode === 'single' ? (suggestedMonthly ?? primaryEnrollment?.monthly_amount ?? l.amount) : null;
        } else {
            patch.period = null;
            patch.enrollment_id = null;
            if (l.category === 'mensualidad') patch.amount = null;
        }
        update(idx, patch);
    };

    const addLine = () => {
        onChange([...lines, newLineDraft({ category: 'torneo', due_date: defaultDue, amount: null, pay: paymentOn })]);
    };

    // Atajo «+ Horas adicionales»: abre la línea de horas (sin modo: el usuario elige «Ya las usó» o
    // «Por adelantado»; sin banco de horas pasa sola a «Ya las usó») en vez de la fila de Torneo vacía.
    // Solo el dueño, un atleta, y una línea de horas por operación.
    const puedeVenderHoras = canOverage && mode === 'single'
        && !lines.some((l) => l.category === 'excedente');
    const addHoras = () => {
        onChange([...lines, newLineDraft({ category: 'excedente', due_date: defaultDue, pay: paymentOn })]);
    };

    return (
        <div className="space-y-2" data-testid="cyp-new-lines">
            {lines.map((l, idx) => {
                const calc = calcByRef.get(`new:${idx}`);
                const single = calc && 'amountAfter' in calc ? (calc as LineCalc) : null;
                const multi = calc && 'perAthlete' in calc ? (calc as MultiLineCalc) : null;
                const showDiscount = openDiscount[l.key] || !!l.discount || !!l.exonerate;
                const isMonthly = l.category === 'mensualidad';
                const pastMonth = isMonthly && l.period && monthsFromToday(l.period, today) < 0;
                const errors = single?.errors ?? multi?.errors ?? [];
                return (
                    <div key={l.key} className="rounded-xl border p-3 space-y-2 bg-background" data-testid={`cyp-line-${idx}`}>
                        <div className="grid gap-2 grid-cols-2 sm:grid-cols-[13rem_minmax(0,1fr)_8rem_9rem_auto]">
                            <Select value={l.category} onValueChange={(v) => changeCategory(idx, v as PaymentChargeCategory)}>
                                <SelectTrigger className="h-10 text-sm" aria-label="Tipo de cobro"><SelectValue /></SelectTrigger>
                                <SelectContent>
                                    {categories.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                                </SelectContent>
                            </Select>
                            {isMonthly ? (
                                <Select
                                    value={l.period ? periodKey(l.period) : undefined}
                                    onValueChange={(v) => {
                                        const p = parsePeriodKey(v);
                                        if (p) update(idx, { period: p, concept: `Mensualidad ${formatPeriodLabel(p.year, p.month)}` });
                                    }}
                                >
                                    <SelectTrigger className="h-10 text-sm" aria-label="Mes de la mensualidad"><SelectValue placeholder="Mes" /></SelectTrigger>
                                    <SelectContent className="max-h-72">
                                        {months.map((p) => <SelectItem key={periodKey(p)} value={periodKey(p)}>{formatPeriodLabel(p.year, p.month)}</SelectItem>)}
                                    </SelectContent>
                                </Select>
                            ) : (
                                <Input
                                    aria-label="Detalle del cobro"
                                    className="h-10 text-sm"
                                    value={l.concept}
                                    placeholder="Ej. Copa Pony 2026 — Sub-12"
                                    maxLength={120}
                                    readOnly={l.category === 'excedente' && l.extra_hours != null}
                                    onChange={(e) => update(idx, { concept: e.target.value })}
                                />
                            )}
                            {mode === 'multi' && isMonthly && l.amount == null ? (
                                <div className="h-10 flex items-center text-xs text-muted-foreground px-2 rounded-md border border-dashed">El de cada atleta</div>
                            ) : (
                                <Input
                                    aria-label="Valor"
                                    type="number"
                                    inputMode="numeric"
                                    min={0}
                                    className="h-10 text-sm tabular-nums"
                                    placeholder="Valor"
                                    value={l.amount ?? ''}
                                    onChange={(e) => update(idx, { amount: e.target.value === '' ? null : Number(e.target.value) })}
                                />
                            )}
                            <Input
                                aria-label="Vence"
                                type="date"
                                className="h-10 text-sm"
                                min={minDue}
                                value={l.due_date}
                                onChange={(e) => update(idx, { due_date: e.target.value })}
                            />
                            <Button
                                type="button" variant="ghost" size="icon" className="h-10 w-10 justify-self-end"
                                aria-label="Quitar línea" onClick={() => onChange(lines.filter((_, i) => i !== idx))}
                            >
                                <Trash2 className="h-4 w-4" />
                            </Button>
                        </div>

                        {isMonthly && mode === 'single' && (suggestions?.enrollments?.length ?? 0) > 1 && (
                            <Select value={l.enrollment_id ?? undefined} onValueChange={(v) => {
                                const e = suggestions!.enrollments.find((x) => x.enrollment_id === v);
                                update(idx, { enrollment_id: v, amount: e?.monthly_amount ?? l.amount });
                            }}>
                                <SelectTrigger className="h-9 text-sm" aria-label="Plan de la mensualidad"><SelectValue placeholder="¿De cuál plan?" /></SelectTrigger>
                                <SelectContent>
                                    {suggestions!.enrollments.map((e) => (
                                        <SelectItem key={e.enrollment_id} value={e.enrollment_id}>
                                            {[e.plan_name, e.team_name].filter(Boolean).join(' · ') || 'Inscripción'}{e.monthly_amount ? ` — ${formatPesos(e.monthly_amount)}` : ''}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        )}
                        {isMonthly && mode === 'single' && suggestedMonthly != null && (
                            <p className="text-[11px] text-muted-foreground">
                                Sugerido {formatPesos(suggestedMonthly)} ({suggestions?.suggested_monthly?.source === 'team' ? 'equipo' : 'plan'})
                                {suggestions?.suggested_monthly?.sibling_discount_pct
                                    ? ` · incluye hermanos −${suggestions.suggested_monthly.sibling_discount_pct} %`
                                    : ''}
                                {l.amount !== suggestedMonthly && (
                                    <Button type="button" variant="link" size="sm" className="h-auto p-0 ml-1 text-[11px]" onClick={() => update(idx, { amount: suggestedMonthly })}>Usar</Button>
                                )}
                            </p>
                        )}
                        {isMonthly && mode === 'multi' && (
                            <div className="flex items-center gap-2">
                                <Checkbox
                                    id={`fixed-${l.key}`}
                                    checked={l.amount != null}
                                    onCheckedChange={(v) => update(idx, { amount: v === true ? 0 : null })}
                                />
                                <Label htmlFor={`fixed-${l.key}`} className="text-xs font-normal">Mismo valor para todos (si no, cada uno con el de su plan)</Label>
                            </div>
                        )}
                        {skippedByLine?.has(idx) ? (
                            <p className="text-xs font-medium text-destructive" role="alert" data-testid={`cyp-line-skipped-${idx}`}>
                                No se creará: {skippedByLine.get(idx)}. Elige otro mes o quita esta línea.
                            </p>
                        ) : pastMonth && <p className="text-[11px] text-amber-700 dark:text-amber-400">Ese mes ya pasó: se crea solo si no existe, y vence desde hoy.</p>}
                        {l.category === 'excedente' && mode === 'single' && (
                            <HorasAdicionalesLine line={l} suggestions={suggestions} onPatch={(patch) => update(idx, patch)} />
                        )}

                        <div className="flex flex-wrap items-center gap-2">
                            <Badge variant="outline" className="text-[10px]">{isMonthly ? 'Mensualidad · da vigencia' : 'Pago único · no genera mora'}</Badge>
                            {single && single.status !== 'not_created' && (
                                <span className="text-xs text-muted-foreground tabular-nums">
                                    Neto <b className="text-foreground">{formatPesos(single.amountAfter)}</b>
                                </span>
                            )}
                            {multi && multi.perAthlete != null && (
                                <span className="text-xs text-muted-foreground tabular-nums">Neto <b className="text-foreground">{formatPesos(multi.perAthlete)}</b> por atleta</span>
                            )}
                            {single?.status === 'not_created' && <span className="text-xs text-violet-700 dark:text-violet-300">No se crea</span>}
                            {mode === 'single' && paymentOn && !l.exonerate && (
                                <div className="flex items-center gap-1.5 ml-auto">
                                    <Checkbox id={`pay-${l.key}`} checked={l.pay} onCheckedChange={(v) => update(idx, { pay: v === true })} />
                                    <Label htmlFor={`pay-${l.key}`} className="text-xs">Pagar</Label>
                                </div>
                            )}
                        </div>
                        <DiscountTags tags={single?.tags ?? multi?.tags ?? []} ratio={single?.discountRatio} over50={single?.over50 ?? multi?.over50} />

                        <div className="flex flex-wrap gap-1.5">
                            {canDiscount && !showDiscount && (
                                <Button type="button" variant="outline" size="sm" className="h-8 text-xs" onClick={() => setOpenDiscount((o) => ({ ...o, [l.key]: true }))}>
                                    Descuento
                                </Button>
                            )}
                            <Input
                                aria-label="Nota interna"
                                className="h-8 text-xs flex-1 min-w-[10rem]"
                                placeholder="Nota interna (la familia no la ve)"
                                maxLength={500}
                                value={l.notes}
                                onChange={(e) => update(idx, { notes: e.target.value })}
                            />
                        </div>
                        {canDiscount && showDiscount && (
                            <DiscountControl
                                idPrefix={`line-${l.key}`}
                                value={l.discount}
                                onChange={(next) => {
                                    update(idx, { discount: next });
                                    if (!next) setOpenDiscount((o) => ({ ...o, [l.key]: false }));
                                }}
                                effect={single?.lineDiscount ?? multi?.lineDiscount}
                                resulting={single ? single.amountAfter : multi?.perAthlete ?? undefined}
                                exonerate={l.exonerate}
                                onExonerateChange={mode === 'single' ? (next) => {
                                    update(idx, { exonerate: next, discount: null });
                                    if (!next) setOpenDiscount((o) => ({ ...o, [l.key]: false }));
                                } : undefined}
                                exonerateHint={isMonthly ? 'beca del mes: queda pagada en $0 y cuenta para la vigencia' : 'esta línea no se crea'}
                            />
                        )}
                        {errors.map((e, i) => <p key={i} className="text-xs text-destructive" role="alert">{e}</p>)}
                    </div>
                );
            })}
            <div className="flex flex-wrap items-center gap-1">
                <Button type="button" variant="ghost" size="sm" onClick={addLine} data-testid="cyp-add-line">
                    <Plus className="h-4 w-4 mr-1" /> Agregar cobro
                </Button>
                {puedeVenderHoras && (
                    <Button type="button" variant="ghost" size="sm" onClick={addHoras} data-testid="cyp-add-horas">
                        <Plus className="h-4 w-4 mr-1" /> Horas adicionales
                    </Button>
                )}
            </div>
        </div>
    );
}
