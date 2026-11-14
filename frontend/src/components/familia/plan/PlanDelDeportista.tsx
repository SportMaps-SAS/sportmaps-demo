/**
 * Pausar, retirar y reactivar el plan — pantalla de la familia y del deportista adulto.
 * Spec: docs/specs/campanas-descuento-referidos-y-plazos-por-whatsapp.md §6 y docs/specs/pausa-vacaciones-enrollments.md.
 *
 * Reutiliza `usePauseConfig` (el interruptor de pausa por escuela) y habla con el BFF
 * `/api/v1/plan-requests`. Si la función aún no existe (503) no pinta nada.
 *
 * Punto de enganche: un solo `<PlanDelDeportista nombre inscripciones />` por deportista.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, LogOut, PauseCircle, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { useToast } from '@/hooks/use-toast';
import { usePauseConfig } from '@/hooks/usePauses';
import { todayColombia } from '@/lib/dateUtils';
import {
    cancelarSolicitud, esFuncionNoDisponible, mensajeErrorPlan, misSolicitudes, pedirPausa,
    pedirReactivacion, pedirRetiro, type MotivoPausa, type SolicitudPlan,
} from '@/lib/api/planRequestsFamilia';
import {
    ETIQUETA_ESTADO, ETIQUETA_TIPO, MAX_MESES_PAUSA, TEXTO_RETIRO, detalleSolicitud, esAbierta,
    esActiva, mesesEntre, opcionesMes, puedeReactivar, resultadoPausa, validarPausa,
    validarReactivacion, validarRetiro,
} from './planModelo';

export interface InscripcionPlan {
    id: string;
    status: string | null;
    /** Equipo o plan, para distinguir inscripciones cuando hay más de una. */
    etiqueta?: string;
}

interface Props {
    nombre: string;
    inscripciones: InscripcionPlan[];
    hoy?: string;
}

type Accion = { tipo: 'pausa' | 'retiro' | 'reactivacion'; inscripcion: InscripcionPlan };

export const CLAVE_SOLICITUDES = ['plan-requests', 'mias'];

export function PlanDelDeportista({ nombre, inscripciones, hoy: hoyProp }: Props) {
    const hoy = hoyProp ?? todayColombia();
    const [accion, setAccion] = useState<Accion | null>(null);
    const ids = useMemo(() => inscripciones.map((i) => i.id), [inscripciones]);
    const q = useQuery({ queryKey: CLAVE_SOLICITUDES, queryFn: misSolicitudes, retry: false, enabled: ids.length > 0 });

    if (ids.length === 0) return null;
    // La función aún no está montada o la migración está pendiente: no se muestra nada.
    if (q.isError && esFuncionNoDisponible(q.error)) return null;

    const propias = (q.data?.solicitudes ?? []).filter((s) => ids.includes(s.enrollment_id));
    const hayAcciones = inscripciones.some((i) => esActiva(i.status) || puedeReactivar(i.status));
    if (!hayAcciones && propias.length === 0) return null;

    const primerNombre = nombre.split(' ')[0] || 'tu deportista';

    return (
        <section className="space-y-3 rounded-xl border bg-card p-3" aria-label={`Plan de ${nombre}`}>
            <h4 className="text-sm font-semibold">Plan de {primerNombre}</h4>
            {inscripciones.map((i) => (
                <AccionesInscripcion
                    key={i.id}
                    inscripcion={i}
                    mostrarEtiqueta={inscripciones.length > 1}
                    abiertas={propias.filter((s) => s.enrollment_id === i.id && esAbierta(s))}
                    onAbrir={(tipo) => setAccion({ tipo, inscripcion: i })}
                />
            ))}

            <MisSolicitudes
                cargando={q.isLoading}
                error={q.isError}
                onReintentar={() => void q.refetch()}
                solicitudes={propias}
            />

            <Sheet open={!!accion} onOpenChange={(o) => { if (!o) setAccion(null); }}>
                <SheetContent side="bottom" className="max-h-[90dvh] overflow-y-auto rounded-t-2xl px-4 pb-6">
                    {accion && (
                        <FormularioAccion
                            key={`${accion.tipo}-${accion.inscripcion.id}`}
                            accion={accion}
                            nombre={nombre}
                            hoy={hoy}
                            onCerrar={() => setAccion(null)}
                        />
                    )}
                </SheetContent>
            </Sheet>
        </section>
    );
}

// ─── Botones por inscripción ────────────────────────────────────────────────

function AccionesInscripcion({ inscripcion, mostrarEtiqueta, abiertas, onAbrir }: {
    inscripcion: InscripcionPlan;
    mostrarEtiqueta: boolean;
    abiertas: SolicitudPlan[];
    onAbrir: (tipo: Accion['tipo']) => void;
}) {
    const activa = esActiva(inscripcion.status);
    const config = usePauseConfig(activa ? inscripcion.id : null);
    const abierta = (tipo: Accion['tipo']) => abiertas.some((s) => s.tipo === tipo);
    const pausaDisponible = activa && !!config.data?.enabled && config.data.enrollment_active;
    const reactivable = puedeReactivar(inscripcion.status);

    if (!activa && !reactivable) return null;

    return (
        <div className="space-y-2">
            {mostrarEtiqueta && inscripcion.etiqueta && (
                <p className="text-xs font-medium text-muted-foreground">{inscripcion.etiqueta}</p>
            )}
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                {pausaDisponible && config.data!.parent_can_request && (
                    <Button
                        variant="outline" className="min-h-touch justify-start"
                        disabled={abierta('pausa')} onClick={() => onAbrir('pausa')}
                    >
                        <PauseCircle className="mr-2 h-4 w-4" aria-hidden="true" />
                        Pausar el plan
                    </Button>
                )}
                {activa && (
                    <Button
                        variant="outline" className="min-h-touch justify-start"
                        disabled={abierta('retiro')} onClick={() => onAbrir('retiro')}
                    >
                        <LogOut className="mr-2 h-4 w-4" aria-hidden="true" />
                        Pedir retiro
                    </Button>
                )}
                {reactivable && (
                    <Button
                        variant="outline" className="min-h-touch justify-start"
                        disabled={abierta('reactivacion')} onClick={() => onAbrir('reactivacion')}
                    >
                        <RotateCcw className="mr-2 h-4 w-4" aria-hidden="true" />
                        Reactivar el plan
                    </Button>
                )}
            </div>
            {pausaDisponible && !config.data!.parent_can_request && (
                <p className="text-xs italic text-muted-foreground">Para pausar el plan, contacta a la escuela.</p>
            )}
        </div>
    );
}

// ─── Mis solicitudes ────────────────────────────────────────────────────────

function MisSolicitudes({ solicitudes, cargando, error, onReintentar }: {
    solicitudes: SolicitudPlan[]; cargando: boolean; error: boolean; onReintentar: () => void;
}) {
    const queryClient = useQueryClient();
    const { toast } = useToast();
    const cancelar = useMutation({
        mutationFn: (s: SolicitudPlan) => cancelarSolicitud(s.tipo, s.id),
        onSuccess: () => {
            toast({ title: 'Solicitud cancelada' });
            void queryClient.invalidateQueries({ queryKey: CLAVE_SOLICITUDES });
        },
        onError: (e) => toast({ title: 'No se pudo cancelar', description: mensajeErrorPlan(e), variant: 'destructive' }),
    });

    if (cargando) {
        return <div className="h-10 animate-pulse rounded-lg bg-muted motion-reduce:animate-none" role="status" aria-label="Cargando tus solicitudes" />;
    }
    if (error) {
        return (
            <div className="text-sm" role="alert">
                <p className="text-muted-foreground">No pudimos cargar tus solicitudes.</p>
                <Button variant="outline" className="mt-1 min-h-touch" onClick={onReintentar}>Reintentar</Button>
            </div>
        );
    }
    if (solicitudes.length === 0) return null;

    return (
        <div className="space-y-2">
            <h5 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Mis solicitudes</h5>
            <ul className="space-y-2">
                {solicitudes.map((s) => (
                    <li key={`${s.tipo}-${s.id}`} className="space-y-1 rounded-lg border p-3 text-sm">
                        <div className="flex items-start justify-between gap-2">
                            <span className="font-medium">{ETIQUETA_TIPO[s.tipo]}</span>
                            <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs font-medium">{ETIQUETA_ESTADO[s.estado]}</span>
                        </div>
                        {detalleSolicitud(s) && <p className="text-muted-foreground">{detalleSolicitud(s)}</p>}
                        {s.estado === 'solicitado' && s.tipo === 'pausa' && s.fuera_de_tope && (
                            <p className="text-xs text-muted-foreground">Pediste más meses de los que la escuela aprueba sola: la revisa la administración.</p>
                        )}
                        {s.nota_administracion && (
                            <p className="text-xs text-muted-foreground">Nota de la escuela: {s.nota_administracion}</p>
                        )}
                        {esAbierta(s) && (
                            <Button
                                variant="outline" className="min-h-touch w-full sm:w-auto"
                                aria-label={`Cancelar solicitud: ${ETIQUETA_TIPO[s.tipo]}`}
                                disabled={cancelar.isPending}
                                onClick={() => cancelar.mutate(s)}
                            >
                                Cancelar solicitud
                            </Button>
                        )}
                    </li>
                ))}
            </ul>
        </div>
    );
}

// ─── Formularios (hoja inferior) ────────────────────────────────────────────

function FormularioAccion({ accion, nombre, hoy, onCerrar }: {
    accion: Accion; nombre: string; hoy: string; onCerrar: () => void;
}) {
    const queryClient = useQueryClient();
    const meses = useMemo(() => opcionesMes(hoy), [hoy]);
    const [motivo, setMotivo] = useState<MotivoPausa>('vacation');
    const [desde, setDesde] = useState(meses[0].value);
    const [hasta, setHasta] = useState(meses[0].value);
    const [fecha, setFecha] = useState('');
    const [mesRegreso, setMesRegreso] = useState(meses[1]?.value ?? meses[0].value);
    const [nota, setNota] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [resultado, setResultado] = useState<string | null>(null);

    const alExito = (mensaje: string) => {
        setResultado(mensaje);
        setError(null);
        void queryClient.invalidateQueries({ queryKey: CLAVE_SOLICITUDES });
        void queryClient.invalidateQueries({ queryKey: ['my-pause-requests'] });
    };

    const enviar = useMutation({
        mutationFn: async () => {
            const enrollment_id = accion.inscripcion.id;
            const detalle = nota.trim() || undefined;
            if (accion.tipo === 'pausa') {
                const r = await pedirPausa({ enrollment_id, reason: motivo, month_from: desde, month_to: hasta, note: detalle });
                return resultadoPausa(r);
            }
            if (accion.tipo === 'retiro') {
                await pedirRetiro({ enrollment_id, exit_date: fecha, reason: detalle });
                return 'Enviamos tu solicitud de retiro. La escuela la revisa y te avisa; hasta entonces el plan sigue como está.';
            }
            await pedirReactivacion({ enrollment_id, from_month: mesRegreso, reason: detalle });
            return 'Enviamos tu solicitud para reactivar el plan. La escuela la revisa y te avisa.';
        },
        onSuccess: alExito,
        onError: (e) => setError(mensajeErrorPlan(e)),
    });

    const validar = (): string | null => {
        if (accion.tipo === 'pausa') return validarPausa(desde, hasta, hoy);
        if (accion.tipo === 'retiro') return validarRetiro(fecha, hoy);
        return validarReactivacion(mesRegreso, hoy);
    };

    const mandar = () => {
        const problema = validar();
        if (problema) { setError(problema); return; }
        setError(null);
        enviar.mutate();
    };

    const titulo = accion.tipo === 'pausa' ? 'Pausar el plan' : accion.tipo === 'retiro' ? 'Pedir retiro' : 'Reactivar el plan';
    const pedidos = mesesEntre(desde, hasta);
    const primerNombre = nombre.split(' ')[0] || 'el deportista';

    return (
        <>
            <SheetHeader className="text-left">
                <SheetTitle>{titulo}</SheetTitle>
                <SheetDescription>
                    {accion.inscripcion.etiqueta ? `${primerNombre} · ${accion.inscripcion.etiqueta}` : primerNombre}
                </SheetDescription>
            </SheetHeader>

            {resultado ? (
                <div className="mt-4 space-y-4">
                    <p className="rounded-xl border bg-muted/40 p-3 text-sm" role="status">{resultado}</p>
                    <Button className="min-h-touch w-full" onClick={onCerrar}>Entendido</Button>
                </div>
            ) : (
                <div className="mt-4 space-y-4">
                    {accion.tipo === 'pausa' && (
                        <>
                            <div className="space-y-1">
                                <Label htmlFor="pausa-motivo">Motivo</Label>
                                <select
                                    id="pausa-motivo"
                                    className="h-touch w-full rounded-md border bg-background px-3 text-base"
                                    value={motivo}
                                    onChange={(e) => setMotivo(e.target.value as MotivoPausa)}
                                >
                                    <option value="vacation">Vacaciones</option>
                                    <option value="injury">Lesión</option>
                                    <option value="other">Otro motivo</option>
                                </select>
                            </div>
                            <div className="grid grid-cols-2 gap-3">
                                <div className="space-y-1">
                                    <Label htmlFor="pausa-desde">Desde el mes</Label>
                                    <select
                                        id="pausa-desde"
                                        className="h-touch w-full rounded-md border bg-background px-2 text-base"
                                        value={desde}
                                        onChange={(e) => { setDesde(e.target.value); if (hasta < e.target.value) setHasta(e.target.value); }}
                                    >
                                        {meses.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                                    </select>
                                </div>
                                <div className="space-y-1">
                                    <Label htmlFor="pausa-hasta">Hasta el mes</Label>
                                    <select
                                        id="pausa-hasta"
                                        className="h-touch w-full rounded-md border bg-background px-2 text-base"
                                        value={hasta}
                                        onChange={(e) => setHasta(e.target.value)}
                                    >
                                        {meses.filter((m) => m.value >= desde).map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                                    </select>
                                </div>
                            </div>
                            <div className="rounded-xl border bg-muted/40 p-3 text-sm">
                                <p>Vas a pausar <strong>{pedidos} mes{pedidos === 1 ? '' : 'es'}</strong> completos (máximo {MAX_MESES_PAUSA}).</p>
                                <p className="mt-1 text-muted-foreground">
                                    Si estás dentro del cupo de pausa de la escuela, queda aprobada al instante y esos meses no se generan cobros.
                                    Si te pasas del cupo, queda pendiente y la revisa la escuela; mientras tanto tus cobros siguen igual.
                                </p>
                            </div>
                        </>
                    )}

                    {accion.tipo === 'retiro' && (
                        <>
                            <div className="space-y-1">
                                <Label htmlFor="retiro-fecha">Fecha de salida</Label>
                                <Input
                                    id="retiro-fecha" type="date" min={hoy} className="h-touch"
                                    value={fecha} onChange={(e) => setFecha(e.target.value)}
                                />
                            </div>
                            <p className="rounded-xl border bg-muted/40 p-3 text-sm">{TEXTO_RETIRO}</p>
                        </>
                    )}

                    {accion.tipo === 'reactivacion' && (
                        <>
                            <div className="space-y-1">
                                <Label htmlFor="reactivar-mes">Mes de regreso</Label>
                                <select
                                    id="reactivar-mes"
                                    className="h-touch w-full rounded-md border bg-background px-3 text-base"
                                    value={mesRegreso}
                                    onChange={(e) => setMesRegreso(e.target.value)}
                                >
                                    {meses.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                                </select>
                            </div>
                            <p className="rounded-xl border bg-muted/40 p-3 text-sm">
                                La escuela revisa tu solicitud. Cuando la apruebe, el plan vuelve a estar activo y los cobros se generan desde ese mes con el ciclo normal.
                            </p>
                        </>
                    )}

                    <div className="space-y-1">
                        <Label htmlFor="plan-nota">Cuéntale a la escuela por qué (opcional)</Label>
                        <Textarea
                            id="plan-nota" rows={2} value={nota}
                            onChange={(e) => setNota(e.target.value.slice(0, 500))}
                            placeholder={accion.tipo === 'pausa' ? 'Ej: viaje familiar, volvemos en agosto' : ''}
                        />
                    </div>

                    {error && <p className="text-sm text-destructive" role="alert">{error}</p>}

                    <div className="flex flex-col gap-2 sm:flex-row-reverse">
                        <Button className="min-h-touch" disabled={enviar.isPending} onClick={mandar}>
                            {enviar.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
                            Enviar solicitud
                        </Button>
                        <Button variant="outline" className="min-h-touch" onClick={onCerrar}>Cancelar</Button>
                    </div>
                </div>
            )}
        </>
    );
}
