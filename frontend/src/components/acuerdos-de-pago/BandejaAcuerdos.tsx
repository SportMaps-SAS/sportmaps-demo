/**
 * Bandeja «Acuerdos de pago» (administración). Spec §5 · contrato §2.
 *
 * Solo se pinta si la escuela tiene prendido `payment_agreements_enabled`
 * (GET /settings/:schoolId → habilitado). Las solicitudes van primero y la
 * insignia dice cuántas hay por resolver. Cada acuerdo muestra su calendario de
 * cuotas, quién lo pidió y por qué canal, y las acciones aprobar / rechazar
 * (solo si el BFF dice `puede_resolver`) y cancelar.
 *
 * Texto sin lenguaje de mora: «cuota sin pagar a tiempo», nunca «morosa».
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CalendarClock, Loader2, RefreshCw } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { getUserFriendlyError } from '@/lib/error-translator';
import { cn, formatCurrency } from '@/lib/utils';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
    ESTADOS_ACUERDO, ETIQUETA_CANAL, ETIQUETA_CUOTA, ETIQUETA_ESTADO,
    calendarioDeAcuerdo, cancelarAcuerdo, contarSolicitados, fechaCorta, fetchAcuerdosDeEscuela, fetchAjustesAcuerdos,
    filtrarAcuerdos, ordenarAcuerdos, resolverAcuerdo, resumenCalendario,
    type Acuerdo, type EstadoAcuerdo,
} from '@/lib/api/acuerdosDePago';

type Accion = { tipo: 'aprobar' | 'rechazar' | 'cancelar'; acuerdo: Acuerdo };

const TEXTO_ACCION: Record<Accion['tipo'], { titulo: string; boton: string; ayuda: string }> = {
    aprobar: { titulo: 'Aprobar acuerdo', boton: 'Aprobar acuerdo', ayuda: 'Las cuotas quedan activas y la familia recibe el calendario.' },
    rechazar: { titulo: 'Rechazar solicitud', boton: 'Rechazar solicitud', ayuda: 'Los cobros siguen con su fecha de siempre. Cuéntale a la familia por qué.' },
    cancelar: { titulo: 'Cancelar acuerdo', boton: 'Cancelar acuerdo', ayuda: 'El acuerdo se cierra y los cobros siguen con su fecha de siempre.' },
};

const COLOR_ESTADO: Record<EstadoAcuerdo, string> = {
    solicitado: 'bg-amber-100 text-amber-900 border-amber-200',
    activo: 'bg-blue-100 text-blue-900 border-blue-200',
    cumplido: 'bg-emerald-100 text-emerald-900 border-emerald-200',
    incumplido: 'bg-orange-100 text-orange-900 border-orange-200',
    rechazado: 'bg-muted text-muted-foreground',
    cancelado: 'bg-muted text-muted-foreground',
};

async function nombresDePerfiles(ids: string[]): Promise<Record<string, string>> {
    if (!ids.length) return {};
    try {
        const { data } = await supabase.from('profiles').select('id, full_name').in('id', ids);
        return Object.fromEntries(((data as Array<{ id: string; full_name: string | null }>) ?? []).filter((p) => p.full_name).map((p) => [p.id, p.full_name as string]));
    } catch {
        return {};
    }
}

export function CalendarioDeCuotas({ acuerdo }: { acuerdo: Acuerdo }) {
    const filas = calendarioDeAcuerdo(acuerdo);
    if (!filas.length) return <p className="text-sm text-muted-foreground">Este acuerdo no trae cuotas.</p>;
    return (
        <div>
            <p className="mb-1 text-xs text-muted-foreground">{resumenCalendario(filas)}</p>
            <ul className="divide-y rounded-md border" aria-label="Calendario de cuotas">
                {filas.map((f) => (
                    <li key={f.seq} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-2 text-sm">
                        <span>Cuota {f.seq} · {f.fecha}</span>
                        <span className="flex items-center gap-2">
                            <span className="font-medium tabular-nums">{formatCurrency(f.monto)}</span>
                            {f.estado && (
                                <Badge variant="outline" className={cn('text-xs', f.estado === 'pagado' && 'border-emerald-300 text-emerald-800', f.estado === 'vencido' && 'border-orange-300 text-orange-800')}>
                                    {ETIQUETA_CUOTA[f.estado]}
                                </Badge>
                            )}
                        </span>
                    </li>
                ))}
            </ul>
        </div>
    );
}

function TarjetaAcuerdo({ a, nombre, puedeResolver, onAccion }: { a: Acuerdo; nombre: string; puedeResolver: boolean; onAccion: (x: Accion) => void }) {
    const abierto = a.status === 'solicitado' || a.status === 'activo';
    return (
        <Card data-testid="acuerdo" data-estado={a.status} className={cn(a.status === 'solicitado' && 'border-amber-300')}>
            <CardHeader className="space-y-1 p-4 pb-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <CardTitle className="break-words text-base">{nombre}</CardTitle>
                    <Badge variant="outline" className={COLOR_ESTADO[a.status]}>{ETIQUETA_ESTADO[a.status]}</Badge>
                </div>
                <CardDescription>
                    Total {formatCurrency(a.total_amount ?? 0)} · pedido el {fechaCorta(a.created_at)} · por {a.source ? ETIQUETA_CANAL[a.source] : 'canal sin registrar'}
                    {a.auto_approved ? ' · aprobado solo por los topes' : ''}
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 p-4 pt-2">
                <CalendarioDeCuotas acuerdo={a} />
                {a.resolution_note && <p className="text-sm"><span className="font-medium">Nota: </span>{a.resolution_note}</p>}
                {abierto && (
                    <div className="flex flex-wrap gap-2">
                        {a.status === 'solicitado' && puedeResolver && (
                            <>
                                <Button size="sm" onClick={() => onAccion({ tipo: 'aprobar', acuerdo: a })} aria-label={`Aprobar el acuerdo de ${nombre}`}>Aprobar</Button>
                                <Button size="sm" variant="outline" onClick={() => onAccion({ tipo: 'rechazar', acuerdo: a })} aria-label={`Rechazar el acuerdo de ${nombre}`}>Rechazar</Button>
                            </>
                        )}
                        <Button size="sm" variant="ghost" onClick={() => onAccion({ tipo: 'cancelar', acuerdo: a })} aria-label={`Cancelar el acuerdo de ${nombre}`}>Cancelar acuerdo</Button>
                    </div>
                )}
                {a.status === 'solicitado' && !puedeResolver && (
                    <p className="text-xs text-muted-foreground">Solo la administración de la escuela puede aprobar o rechazar.</p>
                )}
            </CardContent>
        </Card>
    );
}

export function BandejaAcuerdos({ schoolId }: { schoolId: string }) {
    const { toast } = useToast();
    const qc = useQueryClient();
    const [filtro, setFiltro] = useState<EstadoAcuerdo | 'todos'>('todos');
    const [accion, setAccion] = useState<Accion | null>(null);
    const [nota, setNota] = useState('');

    const ajustes = useQuery({ queryKey: ['acuerdos-ajustes', schoolId], queryFn: () => fetchAjustesAcuerdos(schoolId), staleTime: 60_000 });
    const habilitado = ajustes.data?.habilitado === true;

    const lista = useQuery({
        queryKey: ['acuerdos-escuela', schoolId],
        queryFn: () => fetchAcuerdosDeEscuela(schoolId),
        enabled: habilitado,
    });

    const acuerdos = useMemo(() => ordenarAcuerdos(lista.data?.acuerdos ?? []), [lista.data]);
    const ids = useMemo(() => [...new Set(acuerdos.map((a) => a.payer_profile_id ?? a.requested_by).filter(Boolean) as string[])].sort(), [acuerdos]);
    const nombres = useQuery({ queryKey: ['acuerdos-nombres', ids], queryFn: () => nombresDePerfiles(ids), enabled: ids.length > 0, staleTime: 5 * 60_000 });

    const mutacion = useMutation({
        mutationFn: async ({ tipo, acuerdo }: Accion) => {
            if (tipo === 'cancelar') return cancelarAcuerdo(acuerdo.id, nota);
            return resolverAcuerdo(acuerdo.id, tipo, nota);
        },
        onSuccess: (_r, v) => {
            toast({ title: v.tipo === 'aprobar' ? 'Acuerdo aprobado' : v.tipo === 'rechazar' ? 'Solicitud rechazada' : 'Acuerdo cancelado' });
            setAccion(null);
            setNota('');
            qc.invalidateQueries({ queryKey: ['acuerdos-escuela', schoolId] });
        },
        onError: (e) => toast({ variant: 'destructive', title: 'No se pudo completar', description: getUserFriendlyError(e) }),
    });

    // Función apagada (o sin ajustes legibles): no se muestra nada.
    if (ajustes.isLoading) return <Skeleton className="h-24 w-full" aria-label="Cargando acuerdos de pago" />;
    if (ajustes.isError || !habilitado) return null;

    const porResolver = contarSolicitados(acuerdos);
    const visibles = filtrarAcuerdos(acuerdos, filtro);
    const nombreDe = (a: Acuerdo) => nombres.data?.[a.payer_profile_id ?? a.requested_by ?? ''] ?? 'Familia sin nombre registrado';

    return (
        <section aria-labelledby="acuerdos-titulo" className="min-w-0 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 id="acuerdos-titulo" className="flex items-center gap-2 text-lg font-semibold">
                    <CalendarClock className="h-5 w-5" aria-hidden /> Acuerdos de pago
                    {porResolver > 0 && (
                        <Badge className="bg-amber-500 text-white" aria-label={`${porResolver} por resolver`}>{porResolver}</Badge>
                    )}
                </h2>
                <Button size="sm" variant="outline" onClick={() => lista.refetch()} disabled={lista.isFetching} aria-label="Actualizar acuerdos">
                    <RefreshCw className={cn('mr-1 h-4 w-4', lista.isFetching && 'animate-spin')} aria-hidden /> Actualizar
                </Button>
            </div>

            <div className="flex flex-wrap gap-2" role="group" aria-label="Filtrar por estado">
                {(['todos', ...ESTADOS_ACUERDO] as const).map((e) => (
                    <Button key={e} size="sm" variant={filtro === e ? 'default' : 'outline'} aria-pressed={filtro === e} onClick={() => setFiltro(e)}>
                        {e === 'todos' ? 'Todos' : ETIQUETA_ESTADO[e]}
                    </Button>
                ))}
            </div>

            {lista.isLoading && <Skeleton className="h-32 w-full" aria-label="Cargando acuerdos" />}
            {lista.isError && (
                <div role="alert" className="flex items-start gap-2 rounded-md border border-destructive/40 p-3 text-sm">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
                    <div>
                        <p>No pudimos cargar los acuerdos. {getUserFriendlyError(lista.error)}</p>
                        <Button size="sm" variant="outline" className="mt-2" onClick={() => lista.refetch()}>Reintentar</Button>
                    </div>
                </div>
            )}
            {lista.isSuccess && visibles.length === 0 && (
                <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                    {acuerdos.length === 0
                        ? 'Aún no hay acuerdos de pago. Cuando una familia pida pagar por cuotas desde la app o WhatsApp, aparecerá aquí.'
                        : 'No hay acuerdos con ese estado.'}
                </p>
            )}
            <div className="space-y-3">
                {visibles.map((a) => (
                    <TarjetaAcuerdo key={a.id} a={a} nombre={nombreDe(a)} puedeResolver={lista.data?.puede_resolver === true} onAccion={(x) => { setNota(''); setAccion(x); }} />
                ))}
            </div>

            <Dialog open={!!accion} onOpenChange={(o) => { if (!o && !mutacion.isPending) setAccion(null); }}>
                <DialogContent className="max-h-[90dvh] w-[calc(100vw-2rem)] max-w-md overflow-y-auto">
                    {accion && (
                        <>
                            <DialogHeader>
                                <DialogTitle>{TEXTO_ACCION[accion.tipo].titulo}</DialogTitle>
                                <DialogDescription>{TEXTO_ACCION[accion.tipo].ayuda}</DialogDescription>
                            </DialogHeader>
                            <CalendarioDeCuotas acuerdo={accion.acuerdo} />
                            <div className="space-y-1">
                                <Label htmlFor="nota-acuerdo">Nota para la familia (opcional)</Label>
                                <Textarea id="nota-acuerdo" value={nota} onChange={(e) => setNota(e.target.value)} maxLength={500} rows={3} />
                            </div>
                            <DialogFooter className="gap-2 sm:gap-0">
                                <Button variant="outline" onClick={() => setAccion(null)} disabled={mutacion.isPending}>Volver</Button>
                                <Button
                                    variant={accion.tipo === 'aprobar' ? 'default' : 'destructive'}
                                    disabled={mutacion.isPending}
                                    onClick={() => mutacion.mutate(accion)}
                                >
                                    {mutacion.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
                                    {TEXTO_ACCION[accion.tipo].boton}
                                </Button>
                            </DialogFooter>
                        </>
                    )}
                </DialogContent>
            </Dialog>
        </section>
    );
}

export default BandejaAcuerdos;
