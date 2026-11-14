import { useEffect } from 'react';
import { Minus, Plus, Info, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
    conceptoHorasAdicionales, formatHoras, formatPesos, montoDeHoras, pasoDeHoras, type NewLineDraft,
} from '@/lib/cobrosYPagos';
import type { ChargeSuggestions, EnrollmentOption } from '@/lib/api/chargeBatches';

interface Props {
    line: NewLineDraft;
    suggestions?: ChargeSuggestions | null;
    onPatch: (patch: Partial<NewLineDraft>) => void;
}

/** Detalle por defecto de las horas que la familia ya consumió y ahora se cobran. */
export const CONCEPTO_HORAS_USADAS = 'Hora adicional consumida';

/** Inscripciones del atleta con banco de horas (las únicas a las que se pueden sumar horas). */
export function inscripcionesConHoras(s?: ChargeSuggestions | null): EnrollmentOption[] {
    return (s?.enrollments ?? []).filter((e) => e.hours_plan && e.active !== false);
}

/** Borrador inicial de una venta de horas: 1 hora, su tarifa y la inscripción principal con banco. */
export function borradorDeVentaDeHoras(s?: ChargeSuggestions | null, horas = 1): Partial<NewLineDraft> {
    const lista = inscripcionesConHoras(s);
    const enr = lista.find((e) => e.is_primary) ?? lista[0] ?? null;
    return {
        horas_modo: 'adelantado',
        horas_usadas: null,
        extra_hours: horas,
        overage_charge_id: null,
        enrollment_id: enr?.enrollment_id ?? null,
        concept: conceptoHorasAdicionales(horas),
        amount: montoDeHoras(horas, enr?.hourly_rate) ?? null,
    };
}

/** Detalle de las horas consumidas: «Hora adicional consumida · 2 h». */
export function conceptoHorasUsadas(horas: number): string {
    return `${CONCEPTO_HORAS_USADAS} · ${formatHoras(horas)} h`;
}

/** Tarifa por hora del plan con banco (principal primero): la que se usa para valorar horas ya consumidas. */
export function tarifaDeHorasUsadas(s?: ChargeSuggestions | null): EnrollmentOption | null {
    const lista = inscripcionesConHoras(s);
    return lista.find((e) => e.is_primary && e.hourly_rate != null) ?? lista.find((e) => e.hourly_rate != null) ?? null;
}

/** Horas que le quedan en el banco este mes (todas sus inscripciones con banco); null si no se sabe. */
export function horasDisponiblesEnBanco(s?: ChargeSuggestions | null): number | null {
    const saldos = inscripcionesConHoras(s)
        .map((e) => e.available_minutes)
        .filter((m): m is number => typeof m === 'number');
    if (saldos.length === 0) return null;
    return Math.max(0, saldos.reduce((a, b) => a + b, 0)) / 60;
}

/** «Ya las usó»: solo se cobra; no hay horas que sumar ni inscripción a la que sumarlas. Arranca en 1 hora con su valor. */
export function borradorDeHorasUsadas(s?: ChargeSuggestions | null, horas = 1): Partial<NewLineDraft> {
    const plan = tarifaDeHorasUsadas(s);
    return {
        horas_modo: 'usadas',
        horas_usadas: horas,
        extra_hours: null,
        enrollment_id: null,
        overage_charge_id: null,
        concept: conceptoHorasUsadas(horas),
        ...(plan ? { amount: montoDeHoras(horas, plan.hourly_rate) ?? null } : {}),
    };
}

/**
 * «Horas adicionales» tiene DOS significados que no se pueden confundir:
 *  · «Ya las usó»: la niña se pasó de sus horas y hay que cobrarlo. Solo cobra (si el sistema ya
 *    calculó el excedente del período, se ofrece); el banco de horas NO cambia.
 *  · «Por adelantado»: la familia compra horas antes de usarlas y se SUMAN al banco al quedar pagado.
 * Cuando hay banco de horas el usuario elige (sin opción marcada de antemano). Sin banco solo existe
 * «Ya las usó», y se deja así sin preguntar.
 */
export function HorasAdicionalesLine({ line: l, suggestions, onPatch }: Props) {
    const excedentes = suggestions?.overages ?? [];
    const conHoras = inscripcionesConHoras(suggestions);
    // Las sugerencias aún no llegaron (null) ≠ el atleta no tiene banco (llegaron y no hay inscripción con horas).
    const sinBanco = suggestions != null && conHoras.length === 0;
    const adelantado = l.horas_modo === 'adelantado' || (l.horas_modo == null && l.extra_hours != null);
    const usadas = l.horas_modo === 'usadas';
    const enr = conHoras.find((e) => e.enrollment_id === l.enrollment_id) ?? null;
    const tarifa = enr?.hourly_rate ?? null;
    const planUsadas = tarifaDeHorasUsadas(suggestions);
    const tarifaUsadas = planUsadas?.hourly_rate ?? null;
    const horasQueQuedan = horasDisponiblesEnBanco(suggestions);

    // Sin banco de horas no hay nada que sumar: la línea pasa sola a «Ya las usó» (cobro libre) y limpia
    // cualquier resto de una venta (inscripción o horas del atleta anterior).
    useEffect(() => {
        if (!sinBanco) return;
        if (!usadas || l.extra_hours != null || l.enrollment_id) {
            onPatch({
                ...borradorDeHorasUsadas(suggestions),
                // Si ya traía un detalle propio (el usuario lo escribió), no se pisa.
                ...(usadas && l.concept.trim() ? { concept: l.concept } : {}),
            });
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sinBanco, usadas, l.extra_hours, l.enrollment_id]);

    // En «Por adelantado» la inscripción del borrador tiene que ser de ESTE atleta y llevar banco. Si el
    // atleta cambió con la línea abierta, o las sugerencias llegaron después del borrador, se corrige sola
    // (sin esto el servidor respondía «no es de este atleta»).
    useEffect(() => {
        if (!adelantado || sinBanco || conHoras.length === 0) return;
        if (l.enrollment_id && conHoras.some((e) => e.enrollment_id === l.enrollment_id)) return;
        const nuevo = borradorDeVentaDeHoras(suggestions, l.extra_hours ?? 1);
        onPatch({ enrollment_id: nuevo.enrollment_id ?? null, ...(nuevo.amount != null ? { amount: nuevo.amount } : {}) });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [adelantado, sinBanco, l.enrollment_id, suggestions]);

    const cambiarHoras = (h: number) => {
        const sugerido = montoDeHoras(h, tarifa);
        onPatch({ extra_hours: h, concept: conceptoHorasAdicionales(h), ...(sugerido != null ? { amount: sugerido } : {}) });
    };

    const cambiarHorasUsadas = (h: number) => {
        const sugerido = montoDeHoras(h, tarifaUsadas);
        // El detalle solo se reescribe si es el automático: uno escrito por el usuario se respeta.
        const automatico = !l.concept.trim() || l.concept.startsWith(CONCEPTO_HORAS_USADAS);
        onPatch({
            horas_usadas: h,
            ...(automatico ? { concept: conceptoHorasUsadas(h) } : {}),
            ...(sugerido != null ? { amount: sugerido } : {}),
        });
    };

    return (
        <div className="space-y-2" data-testid="cyp-horas-adicionales">
            {sinBanco ? (
                <p className="text-xs text-muted-foreground flex items-start gap-1" data-testid="cyp-horas-sin-banco">
                    <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                    Este atleta no tiene un plan con banco de horas: se cobra solo el valor y no se suman horas. Escribe el detalle y el valor.
                </p>
            ) : (
                <div className="inline-flex flex-wrap rounded-lg border p-0.5 text-xs" role="group" aria-label="Qué son estas horas">
                    <Button
                        type="button" size="sm" variant={usadas ? 'secondary' : 'ghost'} className="h-7 text-xs" aria-pressed={usadas}
                        onClick={() => onPatch(borradorDeHorasUsadas(suggestions))}
                    >
                        Ya las usó · solo cobrar
                    </Button>
                    <Button
                        type="button" size="sm" variant={adelantado ? 'secondary' : 'ghost'} className="h-7 text-xs" aria-pressed={adelantado}
                        onClick={() => onPatch(borradorDeVentaDeHoras(suggestions))}
                    >
                        Por adelantado · suma al banco
                    </Button>
                </div>
            )}

            {usadas && (
                <>
                    {horasQueQuedan != null && horasQueQuedan > 0 && (
                        <p
                            className="text-xs rounded-md border border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200 px-2.5 py-1.5 flex items-start gap-1.5"
                            data-testid="cyp-horas-usadas-saldo"
                        >
                            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                            <span>
                                Este atleta todavía tiene <b>{formatHoras(horasQueQuedan)} h</b> disponibles en su banco este mes.
                                «Ya las usó» es para cobrar horas <b>por encima</b> del plan y no descuenta del banco: si son horas de su plan, no las cobres.
                            </span>
                        </p>
                    )}
                    {excedentes.length > 0 && (
                        <Select
                            value={l.overage_charge_id ?? undefined}
                            onValueChange={(v) => {
                                const o = excedentes.find((x) => x.id === v);
                                onPatch({ overage_charge_id: v, amount: o?.amount ?? l.amount, concept: o ? `Horas adicionales ${o.period_label}` : l.concept });
                            }}
                        >
                            <SelectTrigger className="h-9 text-sm" aria-label="Período de horas adicionales">
                                <SelectValue placeholder="Excedente del período (o escribe el valor a mano)" />
                            </SelectTrigger>
                            <SelectContent>
                                {excedentes.map((o) => <SelectItem key={o.id} value={o.id}>{o.period_label} — {formatPesos(o.amount)}</SelectItem>)}
                            </SelectContent>
                        </Select>
                    )}
                    {!l.overage_charge_id && (
                        <>
                            <div className="flex flex-wrap items-center gap-2">
                                <span className="text-xs text-muted-foreground">Horas usadas</span>
                                <Button
                                    type="button" variant="outline" size="icon" className="h-9 w-9" aria-label="Una hora usada menos"
                                    onClick={() => cambiarHorasUsadas(pasoDeHoras(l.horas_usadas ?? 1, -1))}
                                >
                                    <Minus className="h-4 w-4" />
                                </Button>
                                <Input
                                    aria-label="Horas usadas"
                                    type="number" inputMode="decimal" step={0.25} min={0.25} max={24}
                                    className="h-9 w-24 text-sm tabular-nums text-center"
                                    value={l.horas_usadas ?? ''}
                                    onChange={(e) => {
                                        const v = e.target.value === '' ? null : Number(e.target.value);
                                        if (v == null || Number.isNaN(v)) { onPatch({ horas_usadas: null }); return; }
                                        cambiarHorasUsadas(v);
                                    }}
                                />
                                <Button
                                    type="button" variant="outline" size="icon" className="h-9 w-9" aria-label="Una hora usada más"
                                    onClick={() => cambiarHorasUsadas(pasoDeHoras(l.horas_usadas ?? 0, 1))}
                                >
                                    <Plus className="h-4 w-4" />
                                </Button>
                                <span className="text-xs text-muted-foreground tabular-nums" data-testid="cyp-horas-usadas-resumen">
                                    {l.horas_usadas && l.horas_usadas > 0 && l.amount != null
                                        ? `${tarifaUsadas != null ? `${formatHoras(l.horas_usadas)} h × ${formatPesos(tarifaUsadas)} ` : ''}= ${formatPesos(l.amount)}`
                                        : ''}
                                </span>
                            </div>
                            <p className="text-[11px] text-muted-foreground" data-testid="cyp-horas-usadas-tarifa">
                                {tarifaUsadas != null
                                    ? <>Tarifa {formatPesos(tarifaUsadas)} por hora{planUsadas?.plan_name ? ` (plan ${planUsadas.plan_name} ÷ sus horas)` : ''}. Puedes cambiar el valor.</>
                                    : 'Este atleta no tiene tarifa por hora calculada: escribe el valor.'}
                            </p>
                        </>
                    )}
                    <p className="text-[11px] text-muted-foreground" data-testid="cyp-horas-usadas-nota">
                        Solo cobra lo que ya usó: <b>el banco de horas no cambia</b>.
                    </p>
                </>
            )}

            {adelantado && !sinBanco && conHoras.length > 0 && (
                <>
                    {conHoras.length > 1 && (
                        <Select
                            value={l.enrollment_id ?? undefined}
                            onValueChange={(v) => {
                                const e = conHoras.find((x) => x.enrollment_id === v);
                                const sugerido = montoDeHoras(l.extra_hours ?? 1, e?.hourly_rate);
                                onPatch({ enrollment_id: v, ...(sugerido != null ? { amount: sugerido } : {}) });
                            }}
                        >
                            <SelectTrigger className="h-9 text-sm" aria-label="Inscripción a la que se suman las horas"><SelectValue placeholder="¿A cuál plan?" /></SelectTrigger>
                            <SelectContent>
                                {conHoras.map((e) => (
                                    <SelectItem key={e.enrollment_id} value={e.enrollment_id}>
                                        {[e.plan_name, e.team_name].filter(Boolean).join(' · ') || 'Inscripción'}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    )}

                    <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs text-muted-foreground">Horas vendidas</span>
                        <Button
                            type="button" variant="outline" size="icon" className="h-9 w-9" aria-label="Una hora menos"
                            onClick={() => cambiarHoras(pasoDeHoras(l.extra_hours ?? 1, -1))}
                        >
                            <Minus className="h-4 w-4" />
                        </Button>
                        <Input
                            aria-label="Horas vendidas"
                            type="number" inputMode="decimal" step={0.25} min={0.25} max={24}
                            className="h-9 w-24 text-sm tabular-nums text-center"
                            value={l.extra_hours ?? ''}
                            onChange={(e) => {
                                const v = e.target.value === '' ? null : Number(e.target.value);
                                if (v == null || Number.isNaN(v)) { onPatch({ extra_hours: 0 }); return; }
                                cambiarHoras(v);
                            }}
                        />
                        <Button
                            type="button" variant="outline" size="icon" className="h-9 w-9" aria-label="Una hora más"
                            onClick={() => cambiarHoras(pasoDeHoras(l.extra_hours ?? 0, 1))}
                        >
                            <Plus className="h-4 w-4" />
                        </Button>
                        <span className="text-xs text-muted-foreground tabular-nums" data-testid="cyp-horas-resumen">
                            {l.extra_hours && l.extra_hours > 0
                                ? `${formatHoras(l.extra_hours)} h${tarifa != null ? ` × ${formatPesos(tarifa)}` : ''}${l.amount != null ? ` = ${formatPesos(l.amount)}` : ''}`
                                : ''}
                        </span>
                    </div>

                    {l.extra_hours != null && l.extra_hours > 0 && (l.amount == null || l.amount <= 0) && (
                        <p className="text-xs font-medium text-amber-700 dark:text-amber-400" data-testid="cyp-horas-sin-valor">
                            Falta el valor: escríbelo en «Valor»{tarifa != null ? ` (sugerido ${formatPesos(montoDeHoras(l.extra_hours, tarifa) ?? 0)})` : ''}.
                        </p>
                    )}
                    <p className="text-[11px] text-muted-foreground" data-testid="cyp-horas-tarifa">
                        {tarifa != null
                            ? <>Tarifa {formatPesos(tarifa)} por hora{enr?.plan_name ? ` (plan ${enr.plan_name} ÷ sus horas)` : ''}. Puedes cambiar el valor.</>
                            : 'El plan no tiene tarifa por hora calculada: escribe el valor.'}
                        {' '}Las horas se suman al banco solo cuando el cobro queda <b>pagado</b> (deja marcado «Pagar»).
                    </p>
                </>
            )}
        </div>
    );
}
