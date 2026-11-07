/**
 * «Pagar por plazos» — pantalla de la familia (y del deportista adulto) en Mis pagos.
 * Spec: docs/specs/campanas-descuento-referidos-y-plazos-por-whatsapp.md §5.
 *
 * Solo se ve si la escuela del cobro tiene prendido el pago por plazos
 * (`GET /settings/:schoolId` → habilitado). Sin lenguaje de mora, deuda ni atraso.
 *
 * Punto de enganche: un solo `<PagarPorPlazos cobros={...} />` en la pantalla de pagos.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import {
    AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
    AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useToast } from '@/hooks/use-toast';
import { formatCurrency } from '@/lib/utils';
import { todayColombia } from '@/lib/dateUtils';
import {
    cancelar, crear, mensajeErrorPlazos, misAcuerdos, settings, vistaPrevia,
    type AcuerdoCreado, type AcuerdoPropio, type VistaPreviaPlazos,
} from '@/lib/api/acuerdosDePagoFamilia';
import { BFFError } from '@/lib/api/bffClient';
import {
    ACUERDO_CANCELABLE, ETIQUETA_ESTADO_ACUERDO, ETIQUETA_ESTADO_CUOTA, fechaLegible,
    fechasSugeridas, proximaFecha, repartirCuotas, textoMotivo, validarFechas, type CobroAbierto,
} from './plazosModelo';

interface Props {
    cobros: CobroAbierto[];
    /** Solo para pruebas: «hoy» en formato AAAA-MM-DD. */
    hoy?: string;
}

const CLAVE_ACUERDOS = ['plazos', 'mine'];

export function PagarPorPlazos({ cobros, hoy }: Props) {
    const escuelas = useMemo(() => [...new Set(cobros.map((c) => c.school_id).filter(Boolean))].sort(), [cobros]);
    const consultas = useQueries({
        queries: escuelas.map((id) => ({
            queryKey: ['plazos', 'settings', id],
            queryFn: () => settings(id),
            staleTime: 5 * 60_000,
            retry: false,
        })),
    });
    const habilitadas = escuelas.filter((_, i) => {
        const a = consultas[i]?.data;
        return !!a?.habilitado && a.max_cuotas >= 2;
    });
    if (habilitadas.length === 0) return null;

    return (
        <section className="space-y-3" aria-label="Pagar por plazos">
            {habilitadas.map((id) => {
                const ajustes = consultas[escuelas.indexOf(id)].data!;
                return (
                    <PlazosEscuela
                        key={id}
                        schoolId={id}
                        maxCuotas={ajustes.max_cuotas}
                        cobros={cobros.filter((c) => c.school_id === id)}
                        hoy={hoy}
                    />
                );
            })}
            <MisAcuerdos />
        </section>
    );
}

// ─── Hoja para armar el acuerdo ─────────────────────────────────────────────

function PlazosEscuela({ schoolId, maxCuotas, cobros, hoy: hoyProp }: {
    schoolId: string; maxCuotas: number; cobros: CobroAbierto[]; hoy?: string;
}) {
    const hoy = hoyProp ?? todayColombia();
    const queryClient = useQueryClient();
    const { toast } = useToast();
    const [abierto, setAbierto] = useState(false);
    const [seleccion, setSeleccion] = useState<string[]>(() => cobros.map((c) => c.id));
    const [cuotas, setCuotas] = useState(2);
    const [fechas, setFechas] = useState<string[]>(() => fechasSugeridas(2, hoy));
    const [error, setError] = useState<string | null>(null);
    const [previa, setPrevia] = useState<VistaPreviaPlazos | null>(null);
    const [creado, setCreado] = useState<AcuerdoCreado | null>(null);

    const elegidos = cobros.filter((c) => seleccion.includes(c.id));
    const saldo = elegidos.reduce((s, c) => s + c.saldo, 0);
    const aprox = repartirCuotas(saldo, cuotas);

    const reiniciar = () => {
        setSeleccion(cobros.map((c) => c.id));
        setCuotas(2);
        setFechas(fechasSugeridas(2, hoy));
        setError(null);
        setPrevia(null);
        setCreado(null);
    };

    const cambiarOpen = (v: boolean) => {
        setAbierto(v);
        if (!v) reiniciar();
    };

    const cambiarCuotas = (n: number) => {
        setCuotas(n);
        setFechas(fechasSugeridas(n, hoy));
        setPrevia(null);
    };

    const alternar = (id: string) => {
        setPrevia(null);
        setSeleccion((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
    };

    const ver = useMutation({
        mutationFn: () => vistaPrevia({ school_id: schoolId, payment_ids: seleccion, cuotas, fechas }),
        onSuccess: (r) => { setPrevia(r); setError(null); },
        onError: (e) => setError(mensajeErrorPlazos(e)),
    });

    const confirmar = useMutation({
        mutationFn: () => crear({
            school_id: schoolId,
            payment_ids: seleccion,
            items: (previa?.cuotas ?? []).map((c) => ({ due_date: c.fecha, amount: c.monto })),
        }),
        onSuccess: (r) => {
            setCreado(r);
            setError(null);
            void queryClient.invalidateQueries({ queryKey: CLAVE_ACUERDOS });
            toast({ title: r.auto_aprobado ? 'Acuerdo activo' : 'Solicitud enviada' });
        },
        onError: (e) => setError(mensajeErrorPlazos(e)),
    });

    const pedirCalendario = () => {
        if (seleccion.length === 0) { setError('Elige al menos un cobro.'); return; }
        const problema = validarFechas(fechas, hoy);
        if (problema) { setError(problema); return; }
        setError(null);
        ver.mutate();
    };

    const opciones = Array.from({ length: Math.max(0, maxCuotas - 1) }, (_, i) => i + 2);

    return (
        <>
            <div className="flex flex-col gap-3 rounded-2xl border bg-card p-4 sm:flex-row sm:items-center">
                <span className="flex h-touch w-touch shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                    <CalendarClock className="h-5 w-5" aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                    <h2 className="text-base font-semibold">Pagar por plazos</h2>
                    <p className="text-sm text-muted-foreground">
                        Divide tus cobros abiertos en cuotas, con las fechas que te sirvan.
                    </p>
                </div>
                <Button className="min-h-touch shrink-0" onClick={() => setAbierto(true)}>
                    Pagar por plazos
                </Button>
            </div>

            <Sheet open={abierto} onOpenChange={cambiarOpen}>
                <SheetContent side="bottom" className="max-h-[90dvh] overflow-y-auto rounded-t-2xl px-4 pb-6">
                    <SheetHeader className="text-left">
                        <SheetTitle>Pagar por plazos</SheetTitle>
                        <SheetDescription>
                            {creado
                                ? 'Tu solicitud quedó registrada.'
                                : previa
                                    ? 'Revisa el calendario antes de confirmar.'
                                    : 'Elige los cobros, en cuántas cuotas y en qué fechas.'}
                        </SheetDescription>
                    </SheetHeader>

                    {creado ? (
                        <div className="mt-4 space-y-4">
                            <p className="rounded-xl border bg-muted/40 p-3 text-sm" role="status">
                                {creado.auto_aprobado
                                    ? `Listo: tu acuerdo de ${creado.cuotas} cuotas por ${formatCurrency(creado.total)} quedó activo. Te avisamos antes de cada fecha.`
                                    : `Enviamos tu solicitud de ${creado.cuotas} cuotas por ${formatCurrency(creado.total)}. La escuela la revisa y te avisa su respuesta. Mientras tanto, tus cobros siguen igual.`}
                            </p>
                            <Button className="min-h-touch w-full" onClick={() => cambiarOpen(false)}>Entendido</Button>
                        </div>
                    ) : previa ? (
                        <div className="mt-4 space-y-4">
                            <ol className="divide-y rounded-xl border" aria-label="Calendario de cuotas">
                                {previa.cuotas.map((c) => (
                                    <li key={c.seq} className="flex min-h-touch items-center justify-between gap-3 px-3 py-2 text-sm">
                                        <span>Cuota {c.seq} · {fechaLegible(c.fecha)}</span>
                                        <span className="font-semibold">{formatCurrency(c.monto)}</span>
                                    </li>
                                ))}
                                <li className="flex min-h-touch items-center justify-between gap-3 bg-muted/40 px-3 py-2 text-sm font-semibold">
                                    <span>Total</span>
                                    <span>{formatCurrency(previa.saldo_total)}</span>
                                </li>
                            </ol>

                            {previa.requiere_aprobacion ? (
                                <div className="rounded-xl border border-amber-300/60 bg-amber-50/60 p-3 text-sm dark:border-amber-500/40 dark:bg-amber-950/10" role="status">
                                    <p className="font-semibold">La escuela tiene que aprobar este plan</p>
                                    <ul className="mt-1 list-disc space-y-1 pl-5 text-muted-foreground">
                                        {previa.motivos.map((m) => <li key={m}>{textoMotivo(m)}</li>)}
                                    </ul>
                                    <p className="mt-2 text-muted-foreground">
                                        Al confirmar enviamos la solicitud. Hasta que la escuela responda, tus cobros siguen igual.
                                    </p>
                                </div>
                            ) : (
                                <p className="rounded-xl border bg-muted/40 p-3 text-sm" role="status">
                                    Este plan queda activo apenas lo confirmes.
                                </p>
                            )}

                            {error && <p className="text-sm text-destructive" role="alert">{error}</p>}

                            <div className="flex flex-col gap-2 sm:flex-row-reverse">
                                <Button className="min-h-touch" disabled={confirmar.isPending} onClick={() => confirmar.mutate()}>
                                    {confirmar.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
                                    {previa.requiere_aprobacion ? 'Enviar solicitud' : 'Confirmar plan'}
                                </Button>
                                <Button variant="outline" className="min-h-touch" disabled={confirmar.isPending} onClick={() => setPrevia(null)}>
                                    Cambiar fechas
                                </Button>
                            </div>
                        </div>
                    ) : (
                        <div className="mt-4 space-y-5">
                            <fieldset className="space-y-2">
                                <legend className="text-sm font-medium">Cobros que quieres dividir</legend>
                                {cobros.map((c) => (
                                    <label key={c.id} className="flex min-h-touch cursor-pointer items-center gap-3 rounded-xl border px-3 py-2 text-sm">
                                        <input
                                            type="checkbox"
                                            className="h-5 w-5 shrink-0"
                                            checked={seleccion.includes(c.id)}
                                            onChange={() => alternar(c.id)}
                                        />
                                        <span className="min-w-0 flex-1 break-words">{c.concept}</span>
                                        <span className="shrink-0 font-semibold">{formatCurrency(c.saldo)}</span>
                                    </label>
                                ))}
                            </fieldset>

                            <div className="space-y-1">
                                <Label htmlFor={`cuotas-${schoolId}`}>¿En cuántas cuotas?</Label>
                                <select
                                    id={`cuotas-${schoolId}`}
                                    className="h-touch w-full rounded-md border bg-background px-3 text-base"
                                    value={cuotas}
                                    onChange={(e) => cambiarCuotas(Number(e.target.value))}
                                >
                                    {opciones.map((n) => <option key={n} value={n}>{n} cuotas</option>)}
                                </select>
                                <p className="text-xs text-muted-foreground">La escuela permite hasta {maxCuotas} cuotas con aprobación inmediata.</p>
                            </div>

                            <fieldset className="space-y-2">
                                <legend className="text-sm font-medium">Fecha de cada cuota</legend>
                                {fechas.map((f, i) => (
                                    <div key={i} className="flex items-center gap-3">
                                        <Label htmlFor={`fecha-${schoolId}-${i}`} className="w-24 shrink-0 text-sm">
                                            Cuota {i + 1}
                                        </Label>
                                        <Input
                                            id={`fecha-${schoolId}-${i}`}
                                            type="date"
                                            min={hoy}
                                            className="h-touch min-w-0 flex-1"
                                            value={f}
                                            onChange={(e) => {
                                                setPrevia(null);
                                                setFechas((fs) => fs.map((x, j) => (j === i ? e.target.value : x)));
                                            }}
                                        />
                                        <span className="w-24 shrink-0 text-right text-sm text-muted-foreground" aria-label={`Valor aproximado de la cuota ${i + 1}`}>
                                            ≈ {formatCurrency(aprox[i] ?? 0)}
                                        </span>
                                    </div>
                                ))}
                            </fieldset>

                            <p className="text-sm text-muted-foreground">
                                Total a repartir: <strong>{formatCurrency(saldo)}</strong>. Los valores exactos los ves en el siguiente paso.
                            </p>

                            {error && <p className="text-sm text-destructive" role="alert">{error}</p>}

                            <Button className="min-h-touch w-full" disabled={ver.isPending} onClick={pedirCalendario}>
                                {ver.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
                                Ver calendario
                            </Button>
                        </div>
                    )}
                </SheetContent>
            </Sheet>
        </>
    );
}

// ─── Mis acuerdos ───────────────────────────────────────────────────────────

function MisAcuerdos() {
    const queryClient = useQueryClient();
    const { toast } = useToast();
    const [aCancelar, setACancelar] = useState<AcuerdoPropio | null>(null);
    const q = useQuery({ queryKey: CLAVE_ACUERDOS, queryFn: misAcuerdos, retry: false });

    const cancelarAcuerdo = useMutation({
        mutationFn: (id: string) => cancelar(id),
        onSuccess: () => {
            toast({ title: 'Acuerdo cancelado', description: 'Tus cobros quedan como estaban.' });
            void queryClient.invalidateQueries({ queryKey: CLAVE_ACUERDOS });
            setACancelar(null);
        },
        onError: (e) => {
            toast({ title: 'No se pudo cancelar', description: mensajeErrorPlazos(e), variant: 'destructive' });
            setACancelar(null);
        },
    });

    if (q.isLoading) {
        return <div className="h-16 animate-pulse rounded-2xl bg-muted motion-reduce:animate-none" role="status" aria-label="Cargando tus acuerdos" />;
    }
    if (q.isError) {
        if (q.error instanceof BFFError && q.error.status === 503) return null;
        return (
            <div className="rounded-2xl border p-4 text-sm" role="alert">
                <p>No pudimos cargar tus acuerdos de pago.</p>
                <Button variant="outline" className="mt-2 min-h-touch" onClick={() => void q.refetch()}>Reintentar</Button>
            </div>
        );
    }
    const acuerdos = q.data?.acuerdos ?? [];
    if (acuerdos.length === 0) return null;

    return (
        <div className="space-y-3">
            <h2 className="text-base font-semibold">Mis acuerdos de pago</h2>
            <ul className="space-y-3">
                {acuerdos.map((a) => {
                    const prox = a.status === 'activo' ? proximaFecha(a) : null;
                    return (
                        <li key={a.id} className="space-y-2 rounded-2xl border bg-card p-4">
                            <div className="flex items-start justify-between gap-2">
                                <p className="text-sm font-semibold">{(a.items?.length ?? 0)} cuotas</p>
                                <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium">
                                    {ETIQUETA_ESTADO_ACUERDO[a.status] ?? a.status}
                                </span>
                            </div>
                            {prox && <p className="text-sm text-muted-foreground">Próxima fecha: {fechaLegible(prox)}</p>}
                            {a.status === 'solicitado' && (
                                <p className="text-sm text-muted-foreground">La escuela está revisando tu solicitud.</p>
                            )}
                            {(a.items?.length ?? 0) > 0 && (
                                <ul className="divide-y rounded-xl border text-sm" aria-label="Cuotas del acuerdo">
                                    {a.items!.map((i, idx) => (
                                        <li key={i.id ?? idx} className="flex min-h-touch items-center justify-between gap-2 px-3 py-2">
                                            <span>{fechaLegible(i.due_date)}</span>
                                            <span className="text-muted-foreground">{ETIQUETA_ESTADO_CUOTA[i.status] ?? i.status}</span>
                                            <span className="font-semibold">{formatCurrency(Number(i.amount))}</span>
                                        </li>
                                    ))}
                                </ul>
                            )}
                            {ACUERDO_CANCELABLE.includes(a.status) && (
                                <Button variant="outline" className="min-h-touch w-full sm:w-auto" onClick={() => setACancelar(a)}>
                                    Cancelar este acuerdo
                                </Button>
                            )}
                        </li>
                    );
                })}
            </ul>

            <AlertDialog open={!!aCancelar} onOpenChange={(o) => { if (!o) setACancelar(null); }}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>¿Cancelar este acuerdo?</AlertDialogTitle>
                        <AlertDialogDescription>
                            Tus cobros vuelven a quedar como estaban y puedes pagarlos completos o pedir otro plan.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel className="min-h-touch">Mantenerlo</AlertDialogCancel>
                        <AlertDialogAction
                            className="min-h-touch"
                            disabled={cancelarAcuerdo.isPending}
                            onClick={(e) => { e.preventDefault(); if (aCancelar) cancelarAcuerdo.mutate(aCancelar.id); }}
                        >
                            Sí, cancelar
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    );
}
