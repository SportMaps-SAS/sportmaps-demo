/**
 * Bandeja «Solicitudes de plan» (administración): retiro, pausa y reactivación
 * mezcladas, con filtros por tipo y estado. Contrato §3 (GET /escuela/:schoolId,
 * POST /:tipo/:id/resolver). Las por resolver van primero, con insignia.
 *
 * Aprobar un retiro NO da de baja por defecto: la casilla «Dar de baja completa»
 * viene desmarcada y `dar_de_baja` solo viaja en retiros. Si el retiro es de
 * doble categoría, el BFF devuelve `payments_a_revisar` y se avisa.
 *
 * `habilitado=false` no pinta nada (la función apagada no se ve).
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ClipboardList, Loader2, RefreshCw } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { getUserFriendlyError } from '@/lib/error-translator';
import { cn } from '@/lib/utils';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
    ETIQUETA_CANAL_SOLICITUD, ETIQUETA_ESTADO_SOLICITUD, ETIQUETA_MOTIVO_PAUSA, ETIQUETA_TIPO,
    contarPorResolver, fetchSolicitudesDeEscuela, filtrarSolicitudes, ordenarSolicitudes, resolverSolicitud, textoFechas,
    type EstadoSolicitud, type Solicitud, type TipoSolicitud,
} from '@/lib/api/planRequests';

const TIPOS: Array<TipoSolicitud | 'todos'> = ['todos', 'retiro', 'pausa', 'reactivacion'];
const ESTADOS: Array<EstadoSolicitud | 'todos'> = ['todos', 'solicitado', 'aprobado', 'rechazado', 'cancelado'];

const COLOR_ESTADO: Record<EstadoSolicitud, string> = {
    solicitado: 'bg-amber-100 text-amber-900 border-amber-200',
    aprobado: 'bg-emerald-100 text-emerald-900 border-emerald-200',
    rechazado: 'bg-muted text-muted-foreground',
    cancelado: 'bg-muted text-muted-foreground',
};

type Decision = { s: Solicitud; decision: 'aprobar' | 'rechazar' };

function TarjetaSolicitud({ s, onDecidir }: { s: Solicitud; onDecidir: (d: Decision) => void }) {
    const nombre = s.atleta_nombre ?? 'Deportista sin nombre registrado';
    return (
        <Card data-testid="solicitud" data-tipo={s.tipo} data-estado={s.estado} className={cn(s.estado === 'solicitado' && 'border-amber-300')}>
            <CardHeader className="space-y-1 p-4 pb-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <CardTitle className="break-words text-base">{nombre}</CardTitle>
                    <div className="flex flex-wrap gap-1">
                        <Badge variant="secondary">{ETIQUETA_TIPO[s.tipo]}</Badge>
                        <Badge variant="outline" className={COLOR_ESTADO[s.estado]}>{ETIQUETA_ESTADO_SOLICITUD[s.estado]}</Badge>
                    </div>
                </div>
                <CardDescription>{textoFechas(s)}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 p-4 pt-2 text-sm">
                <p className="text-muted-foreground">
                    Pedida por {s.canal ? ETIQUETA_CANAL_SOLICITUD[s.canal] : 'un canal sin registrar'}
                    {s.solicitante_rol === 'parent' ? ' (acudiente)' : s.solicitante_rol === 'athlete' ? ' (deportista)' : ''}
                    {s.auto_aprobada ? ' · aprobada sola dentro del tope' : ''}
                </p>
                {s.tipo === 'pausa' && s.motivo && <p><span className="font-medium">Motivo: </span>{ETIQUETA_MOTIVO_PAUSA[s.motivo] ?? s.motivo}</p>}
                {s.detalle_motivo && <p><span className="font-medium">{s.tipo === 'pausa' ? 'Detalle: ' : 'Motivo: '}</span>{s.detalle_motivo}</p>}
                {s.fuera_de_tope && (
                    <p className="flex items-start gap-1 text-amber-800">
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                        Esta pausa pasa el tope de meses de la escuela: por eso espera tu decisión.
                    </p>
                )}
                {s.nota_administracion && <p><span className="font-medium">Nota de la escuela: </span>{s.nota_administracion}</p>}
                {s.estado === 'solicitado' && (
                    <div className="flex flex-wrap gap-2 pt-1">
                        <Button size="sm" onClick={() => onDecidir({ s, decision: 'aprobar' })} aria-label={`Aprobar ${ETIQUETA_TIPO[s.tipo].toLowerCase()} de ${nombre}`}>Aprobar</Button>
                        <Button size="sm" variant="outline" onClick={() => onDecidir({ s, decision: 'rechazar' })} aria-label={`Rechazar ${ETIQUETA_TIPO[s.tipo].toLowerCase()} de ${nombre}`}>Rechazar</Button>
                    </div>
                )}
            </CardContent>
        </Card>
    );
}

export function BandejaSolicitudesPlan({ schoolId, habilitado = true }: { schoolId: string; habilitado?: boolean }) {
    const { toast } = useToast();
    const qc = useQueryClient();
    const [tipo, setTipo] = useState<TipoSolicitud | 'todos'>('todos');
    const [estado, setEstado] = useState<EstadoSolicitud | 'todos'>('todos');
    const [dec, setDec] = useState<Decision | null>(null);
    const [nota, setNota] = useState('');
    const [darDeBaja, setDarDeBaja] = useState(false);
    const [aRevisar, setARevisar] = useState<number | null>(null);

    const q = useQuery({ queryKey: ['solicitudes-plan', schoolId], queryFn: () => fetchSolicitudesDeEscuela(schoolId), enabled: habilitado });
    const todas = useMemo(() => ordenarSolicitudes(q.data?.solicitudes ?? []), [q.data]);
    const visibles = useMemo(() => filtrarSolicitudes(todas, { tipo, estado }), [todas, tipo, estado]);
    const porResolver = contarPorResolver(todas);

    const m = useMutation({
        mutationFn: ({ s, decision }: Decision) => resolverSolicitud(s.tipo, s.id, { decision, note: nota, dar_de_baja: darDeBaja }),
        onSuccess: (r, v) => {
            toast({ title: v.decision === 'aprobar' ? 'Solicitud aprobada' : 'Solicitud rechazada' });
            const n = Number(r?.payments_a_revisar ?? 0);
            setARevisar(v.decision === 'aprobar' && v.s.tipo === 'retiro' && n > 0 ? n : null);
            setDec(null);
            qc.invalidateQueries({ queryKey: ['solicitudes-plan', schoolId] });
        },
        onError: (e) => toast({ variant: 'destructive', title: 'No se pudo resolver la solicitud', description: getUserFriendlyError(e) }),
    });

    if (!habilitado) return null;

    const abrir = (d: Decision) => { setNota(''); setDarDeBaja(false); setDec(d); };
    const esRetiroAprobar = dec?.s.tipo === 'retiro' && dec.decision === 'aprobar';

    return (
        <section aria-labelledby="solicitudes-plan-titulo" className="min-w-0 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 id="solicitudes-plan-titulo" className="flex items-center gap-2 text-lg font-semibold">
                    <ClipboardList className="h-5 w-5" aria-hidden /> Solicitudes de plan
                    {porResolver > 0 && <Badge className="bg-amber-500 text-white" aria-label={`${porResolver} por resolver`}>{porResolver}</Badge>}
                </h2>
                <Button size="sm" variant="outline" onClick={() => q.refetch()} disabled={q.isFetching} aria-label="Actualizar solicitudes">
                    <RefreshCw className={cn('mr-1 h-4 w-4', q.isFetching && 'animate-spin')} aria-hidden /> Actualizar
                </Button>
            </div>

            <div className="space-y-2">
                <div className="flex flex-wrap gap-2" role="group" aria-label="Filtrar por tipo">
                    {TIPOS.map((t) => (
                        <Button key={t} size="sm" variant={tipo === t ? 'default' : 'outline'} aria-pressed={tipo === t} onClick={() => setTipo(t)}>
                            {t === 'todos' ? 'Todas las clases' : ETIQUETA_TIPO[t]}
                        </Button>
                    ))}
                </div>
                <div className="flex flex-wrap gap-2" role="group" aria-label="Filtrar por estado">
                    {ESTADOS.map((e) => (
                        <Button key={e} size="sm" variant={estado === e ? 'default' : 'outline'} aria-pressed={estado === e} onClick={() => setEstado(e)}>
                            {e === 'todos' ? 'Todos los estados' : ETIQUETA_ESTADO_SOLICITUD[e]}
                        </Button>
                    ))}
                </div>
            </div>

            {aRevisar != null && (
                <Alert role="status">
                    <AlertDescription>
                        El retiro quedó aprobado, pero el deportista tiene otra inscripción activa: {aRevisar} {aRevisar === 1 ? 'cobro quedó' : 'cobros quedaron'} sin anular para que los revises a mano en Cobros.
                        <Button size="sm" variant="link" className="ml-1 h-auto p-0" onClick={() => setARevisar(null)}>Entendido</Button>
                    </AlertDescription>
                </Alert>
            )}

            {q.isLoading && <Skeleton className="h-32 w-full" aria-label="Cargando solicitudes" />}
            {q.isError && (
                <div role="alert" className="flex items-start gap-2 rounded-md border border-destructive/40 p-3 text-sm">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
                    <div>
                        <p>No pudimos cargar las solicitudes. {getUserFriendlyError(q.error)}</p>
                        <Button size="sm" variant="outline" className="mt-2" onClick={() => q.refetch()}>Reintentar</Button>
                    </div>
                </div>
            )}
            {q.isSuccess && visibles.length === 0 && (
                <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                    {todas.length === 0
                        ? 'Aún no hay solicitudes. Cuando una familia pida pausar, retirar o reactivar un plan desde la app o WhatsApp, aparecerá aquí.'
                        : 'No hay solicitudes con esos filtros.'}
                </p>
            )}
            <div className="space-y-3">
                {visibles.map((s) => <TarjetaSolicitud key={`${s.tipo}-${s.id}`} s={s} onDecidir={abrir} />)}
            </div>

            <Dialog open={!!dec} onOpenChange={(o) => { if (!o && !m.isPending) setDec(null); }}>
                <DialogContent className="max-h-[90dvh] w-[calc(100vw-2rem)] max-w-md overflow-y-auto">
                    {dec && (
                        <>
                            <DialogHeader>
                                <DialogTitle>{dec.decision === 'aprobar' ? 'Aprobar' : 'Rechazar'} {ETIQUETA_TIPO[dec.s.tipo].toLowerCase()}</DialogTitle>
                                <DialogDescription>
                                    {dec.s.atleta_nombre ?? 'Deportista'} · {textoFechas(dec.s)}
                                </DialogDescription>
                            </DialogHeader>
                            {esRetiroAprobar && (
                                <div className="space-y-2 rounded-md border p-3">
                                    <div className="flex items-start gap-3">
                                        <Checkbox id="dar-de-baja" checked={darDeBaja} onCheckedChange={(v) => setDarDeBaja(v === true)} />
                                        <Label htmlFor="dar-de-baja" className="font-medium">Dar de baja completa al deportista</Label>
                                    </div>
                                    <p className="text-xs text-muted-foreground">
                                        Desmarcada, solo se retira esta inscripción desde la fecha de salida y se anulan sus cobros desde esa fecha.
                                        Marcada, además se cancelan TODAS las inscripciones del deportista y su deuda pendiente.
                                    </p>
                                </div>
                            )}
                            <div className="space-y-1">
                                <Label htmlFor="nota-solicitud">Nota para la familia (opcional)</Label>
                                <Textarea id="nota-solicitud" value={nota} onChange={(e) => setNota(e.target.value)} maxLength={500} rows={3} />
                            </div>
                            <DialogFooter className="gap-2 sm:gap-0">
                                <Button variant="outline" onClick={() => setDec(null)} disabled={m.isPending}>Volver</Button>
                                <Button variant={dec.decision === 'aprobar' ? 'default' : 'destructive'} disabled={m.isPending} onClick={() => m.mutate(dec)}>
                                    {m.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
                                    {dec.decision === 'aprobar' ? 'Aprobar solicitud' : 'Rechazar solicitud'}
                                </Button>
                            </DialogFooter>
                        </>
                    )}
                </DialogContent>
            </Dialog>
        </section>
    );
}

export default BandejaSolicitudesPlan;
