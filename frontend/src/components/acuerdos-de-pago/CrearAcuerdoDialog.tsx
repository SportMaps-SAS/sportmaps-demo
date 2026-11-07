/**
 * Crear un acuerdo de pago a nombre de una familia (administración), desde
 * «Cobros abiertos» de una inscripción. Se eligen los cobros, cuántas cuotas, y
 * `POST /preview` arma el calendario; al confirmar, `POST /` con `payer_profile_id`.
 *
 * Punto de enganche (no cableado aquí): en ResolverCobrosAbiertosDialog o en el
 * menú del atleta, abrir <CrearAcuerdoDialog .../> con el enrollmentId y el
 * perfil de quien paga. Solo debe ofrecerse si `payment_agreements_enabled`.
 */
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { getUserFriendlyError } from '@/lib/error-translator';
import { formatCurrency } from '@/lib/utils';
import { fetchCobrosAbiertos, mesLegible } from '@/lib/cobrosAbiertos';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
    calendarioDeVistaPrevia, crearAcuerdo, fetchAjustesAcuerdos, resumenCalendario, textoMotivos, vistaPreviaAcuerdo,
} from '@/lib/api/acuerdosDePago';

interface Props {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    schoolId: string;
    enrollmentId: string | null;
    /** Perfil de quien paga (el acuerdo queda a su nombre). Sin él no se puede crear. */
    payerProfileId: string | null;
    athleteName: string;
}

export function CrearAcuerdoDialog({ open, onOpenChange, schoolId, enrollmentId, payerProfileId, athleteName }: Props) {
    const { toast } = useToast();
    const qc = useQueryClient();
    const [elegidos, setElegidos] = useState<string[]>([]);
    const [cuotasTxt, setCuotasTxt] = useState('2');

    const ajustes = useQuery({ queryKey: ['acuerdos-ajustes', schoolId], queryFn: () => fetchAjustesAcuerdos(schoolId), enabled: open });
    const cobros = useQuery({
        queryKey: ['cobros-abiertos-acuerdo', enrollmentId],
        queryFn: () => fetchCobrosAbiertos(enrollmentId as string),
        enabled: open && !!enrollmentId,
    });
    const elegibles = useMemo(
        () => (cobros.data?.cobros ?? []).filter((c) => c.status !== 'awaiting_approval' && c.amount - c.amount_paid > 0),
        [cobros.data],
    );

    useEffect(() => { if (open) { setElegidos([]); setCuotasTxt('2'); } }, [open, enrollmentId]);

    const cuotas = Number(cuotasTxt);
    const cuotasValidas = Number.isInteger(cuotas) && cuotas >= 1 && cuotas <= 24;

    const vista = useQuery({
        queryKey: ['acuerdo-preview', schoolId, [...elegidos].sort(), cuotas],
        queryFn: () => vistaPreviaAcuerdo({ school_id: schoolId, payment_ids: elegidos, cuotas }),
        enabled: open && elegidos.length > 0 && cuotasValidas,
        retry: false,
    });

    const crear = useMutation({
        mutationFn: () => crearAcuerdo({
            school_id: schoolId,
            payment_ids: elegidos,
            items: (vista.data?.cuotas ?? []).map((c) => ({ due_date: c.fecha, amount: c.monto })),
            payer_profile_id: payerProfileId as string,
        }),
        onSuccess: (r) => {
            toast({ title: r.auto_aprobado ? 'Acuerdo creado y activo' : 'Acuerdo creado: queda por resolver en la bandeja' });
            qc.invalidateQueries({ queryKey: ['acuerdos-escuela', schoolId] });
            onOpenChange(false);
        },
        onError: (e) => toast({ variant: 'destructive', title: 'No se pudo crear el acuerdo', description: getUserFriendlyError(e) }),
    });

    const apagado = ajustes.data && ajustes.data.habilitado === false;
    const filas = vista.data ? calendarioDeVistaPrevia(vista.data) : [];
    const puedeCrear = !!payerProfileId && !!vista.data && !crear.isPending && !apagado;

    return (
        <Dialog open={open} onOpenChange={(o) => { if (!crear.isPending) onOpenChange(o); }}>
            <DialogContent className="max-h-[90dvh] w-[calc(100vw-2rem)] max-w-lg overflow-y-auto">
                <DialogHeader>
                    <DialogTitle>Acordar pago en cuotas</DialogTitle>
                    <DialogDescription>Para {athleteName}. Elige los cobros que entran en el acuerdo y en cuántas cuotas se pagan.</DialogDescription>
                </DialogHeader>

                {apagado && <Alert><AlertDescription>El pago por plazos está apagado en esta escuela. Préndelo en los ajustes de cobros para crear acuerdos.</AlertDescription></Alert>}
                {!payerProfileId && <Alert><AlertDescription>Esta inscripción no tiene una persona que pague con cuenta. Solo se pueden crear acuerdos para pagadores con cuenta.</AlertDescription></Alert>}

                {cobros.isLoading && <p className="text-sm text-muted-foreground">Cargando cobros abiertos…</p>}
                {cobros.isError && <p role="alert" className="text-sm text-destructive">No pudimos cargar los cobros. {getUserFriendlyError(cobros.error)}</p>}
                {cobros.isSuccess && elegibles.length === 0 && <p className="text-sm text-muted-foreground">No hay cobros abiertos con saldo para acordar.</p>}

                {elegibles.length > 0 && (
                    <fieldset className="space-y-2">
                        <legend className="mb-1 text-sm font-medium">Cobros</legend>
                        {elegibles.map((c) => {
                            const id = `cobro-acuerdo-${c.payment_id}`;
                            const checked = elegidos.includes(c.payment_id);
                            return (
                                <div key={c.payment_id} className="flex items-center gap-3 rounded-md border p-2">
                                    <Checkbox id={id} checked={checked} onCheckedChange={(v) => setElegidos((x) => (v ? [...x, c.payment_id] : x.filter((i) => i !== c.payment_id)))} />
                                    <Label htmlFor={id} className="flex flex-1 flex-wrap justify-between gap-x-2 text-sm font-normal">
                                        <span>{c.concepto ?? 'Cobro'} · {mesLegible(c)}</span>
                                        <span className="tabular-nums">{formatCurrency(c.amount - c.amount_paid)}</span>
                                    </Label>
                                </div>
                            );
                        })}
                    </fieldset>
                )}

                {elegidos.length > 0 && (
                    <div className="space-y-1">
                        <Label htmlFor="acuerdo-cuotas">Número de cuotas</Label>
                        <Input id="acuerdo-cuotas" inputMode="numeric" className="w-28" value={cuotasTxt} onChange={(e) => setCuotasTxt(e.target.value.replace(/\D/g, ''))} aria-invalid={!cuotasValidas} />
                        {!cuotasValidas && <p role="alert" className="text-xs text-destructive">Escribe un número de cuotas entre 1 y 24.</p>}
                    </div>
                )}

                {vista.isFetching && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Armando el calendario…</p>}
                {vista.isError && <p role="alert" className="text-sm text-destructive">No se pudo armar el calendario. {getUserFriendlyError(vista.error)}</p>}
                {vista.data && !vista.isFetching && (
                    <div className="space-y-2">
                        <p className="text-sm font-medium">{resumenCalendario(filas)} · total {formatCurrency(vista.data.saldo_total)}</p>
                        <ul className="divide-y rounded-md border" aria-label="Calendario propuesto">
                            {filas.map((f) => (
                                <li key={f.seq} className="flex justify-between gap-2 px-3 py-2 text-sm">
                                    <span>Cuota {f.seq} · {f.fecha}</span>
                                    <span className="tabular-nums">{formatCurrency(f.monto)}</span>
                                </li>
                            ))}
                        </ul>
                        {vista.data.requiere_aprobacion && (
                            <Alert>
                                <AlertDescription>
                                    Este acuerdo pasa los topes y quedará por resolver en la bandeja:
                                    <ul className="ml-4 list-disc">{textoMotivos(vista.data.motivos).map((m) => <li key={m}>{m}</li>)}</ul>
                                </AlertDescription>
                            </Alert>
                        )}
                    </div>
                )}

                <DialogFooter className="gap-2 sm:gap-0">
                    <Button variant="outline" onClick={() => onOpenChange(false)} disabled={crear.isPending}>Cerrar</Button>
                    <Button onClick={() => crear.mutate()} disabled={!puedeCrear}>
                        {crear.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
                        Crear acuerdo
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

export default CrearAcuerdoDialog;
