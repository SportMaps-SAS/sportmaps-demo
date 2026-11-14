/**
 * WhatsApp › Seguimiento (docs/specs/whatsapp-ventas-de-servicio-blindaje.md §4.E).
 *
 * La lista que pidió la escuela: por conversación, quién escribió y de qué, si
 * respondió la escuela (desde el celular o el buzón), si respondió el bot, quién
 * quedó esperando y desde cuándo, si se mandaron los datos de pago, si llegó el
 * comprobante, el cobro, y las preguntas que el bot le pasó a la escuela y nadie
 * contestó. En rojo lo que lleva más de 2 h esperando o tiene pendientes.
 *
 * Nació en la clínica de Monster (nov 2026): el bot pasó 12 preguntas a la escuela,
 * 6 nunca tuvieron respuesta y nadie se enteró.
 *
 * Datos: GET /api/v1/whatsapp/:schoolId/seguimiento (y `formato=csv` para Excel).
 * Clic en una fila: abre la conversación en el buzón.
 */
import { useCallback, useEffect, useState, type KeyboardEvent } from 'react';
import { bffClient } from '@/lib/api/bffClient';
import { useToast } from '@/hooks/use-toast';
import { formatCurrency } from '@/lib/utils';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import {
    Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { AlertTriangle, Download, Loader2, MessagesSquare, RefreshCw } from 'lucide-react';
import { rangoUltimosDias } from './anunciosModelo';
import {
    AYUDA_AUTOR, DIAS_MAXIMO, ETIQUETA_AUTOR, TONO_AUTOR, diasDelRango, etiquetaEstadoCobro, etiquetaTipoCobro,
    fechaCorta, haceCuanto, telefonoLegible, textoDeError,
    type Autor, type FilaSeguimiento, type RespuestaSeguimiento,
} from './seguimientoModelo';

const RANGOS = [7, 14, 31] as const;
const TODOS = 'todos';
const TEMAS_FIJOS = [
    { valor: 'clase_prueba', texto: 'Clase de prueba' },
    { valor: 'familia', texto: 'Familias' },
    { valor: 'otro', texto: 'Otros' },
] as const;

// ─── Piezas ─────────────────────────────────────────────────────────────────

function DeQuien({ de }: { de: Autor }) {
    return (
        <Badge variant="outline" className={`whitespace-nowrap font-normal ${TONO_AUTOR[de]}`} title={AYUDA_AUTOR[de]}>
            {ETIQUETA_AUTOR[de]}
        </Badge>
    );
}

function SiNo({ si, etiqueta }: { si: boolean; etiqueta: string }) {
    return (
        <span className={si ? 'font-medium text-emerald-700 dark:text-emerald-400' : 'text-muted-foreground'} aria-label={`${etiqueta}: ${si ? 'sí' : 'no'}`}>
            {si ? 'Sí' : 'No'}
        </span>
    );
}

function Espera({ fila }: { fila: FilaSeguimiento }) {
    if (fila.esperandoMin === null) return <span className="text-muted-foreground">—</span>;
    const largo = fila.esperandoMin > 120;
    return (
        <span className={`whitespace-nowrap tabular-nums ${largo ? 'font-semibold text-red-700 dark:text-red-400' : ''}`}
            title={`Desde ${fechaCorta(fila.esperandoDesde)}`}>
            {haceCuanto(fila.esperandoMin)}
        </span>
    );
}

function Pago({ fila }: { fila: FilaSeguimiento }) {
    const nada = !fila.datosDePagoEnviados && !fila.comprobanteRecibido && !fila.cobro;
    if (nada) return <span className="text-muted-foreground">—</span>;
    return (
        <div className="space-y-0.5 text-xs">
            {fila.datosDePagoEnviados && <p>Datos de pago enviados</p>}
            {fila.comprobanteRecibido && (
                <p>Comprobante{fila.comprobantes > 1 ? ` (${fila.comprobantes})` : ''}: {fila.comprobanteEstado ?? 'recibido'}</p>
            )}
            {fila.cobro && (
                <p className="font-medium">
                    {formatCurrency(fila.cobro.monto)} · {etiquetaEstadoCobro(fila.cobro.estado)}
                    <span className="font-normal text-muted-foreground">
                        {' · '}{fila.cobro.concepto || etiquetaTipoCobro(fila.cobro.tipo)}
                        {fila.cobro.cuantos > 1 ? ` (+${fila.cobro.cuantos - 1})` : ''}
                    </span>
                </p>
            )}
        </div>
    );
}

function Pendientes({ fila }: { fila: FilaSeguimiento }) {
    if (!fila.pendientesEscuela.length) return null;
    return (
        <ul className="space-y-1 text-xs text-red-800 dark:text-red-300">
            {fila.pendientesEscuela.map((p) => (
                <li key={`${p.desde}:${p.texto}`} className="flex gap-1">
                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                    <span className="break-words">«{p.texto}» <span className="text-muted-foreground">· {fechaCorta(p.desde)}</span></span>
                </li>
            ))}
        </ul>
    );
}

function Contacto({ fila }: { fila: FilaSeguimiento }) {
    return (
        <div className="min-w-0">
            <p className="font-medium leading-tight break-words">{fila.contacto.nombre || 'Sin nombre'}</p>
            <p className="text-xs text-muted-foreground tabular-nums">{telefonoLegible(fila.contacto.telefono)}</p>
            {fila.tomada && <p className="text-xs text-muted-foreground">La atiende una persona</p>}
        </div>
    );
}

// ─── Componente ─────────────────────────────────────────────────────────────

export function SeguimientoConversaciones({ schoolId, onAbrirConversacion }: {
    schoolId: string;
    /** Abre la conversación en el buzón (pestaña Conversaciones). */
    onAbrirConversacion?: (conversacionId: string) => void;
}) {
    const { toast } = useToast();
    const [rango, setRango] = useState(() => rangoUltimosDias(14));
    const [servicio, setServicio] = useState<string>(TODOS);
    const [soloSinResponder, setSoloSinResponder] = useState(false);
    const [datos, setDatos] = useState<RespuestaSeguimiento | null>(null);
    const [cargando, setCargando] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [descargando, setDescargando] = useState(false);

    const dias = diasDelRango(rango.desde, rango.hasta);
    const rangoValido = rango.desde <= rango.hasta && dias <= DIAS_MAXIMO;

    const consulta = useCallback((extra: Record<string, string> = {}) => {
        const qs = new URLSearchParams({ desde: rango.desde, hasta: rango.hasta });
        if (servicio !== TODOS) qs.set('servicio', servicio);
        if (soloSinResponder) qs.set('soloSinResponder', '1');
        for (const [k, v] of Object.entries(extra)) qs.set(k, v);
        return `/api/v1/whatsapp/${schoolId}/seguimiento?${qs.toString()}`;
    }, [schoolId, rango.desde, rango.hasta, servicio, soloSinResponder]);

    const cargar = useCallback(async () => {
        if (!rangoValido) return;
        setCargando(true);
        setError(null);
        try {
            setDatos(await bffClient.get<RespuestaSeguimiento>(consulta()));
        } catch (e: unknown) {
            setError(textoDeError(e instanceof Error ? e.message : 'Error desconocido'));
        } finally {
            setCargando(false);
        }
    }, [consulta, rangoValido]);

    useEffect(() => { void cargar(); }, [cargar]);

    const descargar = async () => {
        setDescargando(true);
        try {
            const blob = await bffClient.getBlob(consulta({ formato: 'csv' }));
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `seguimiento-whatsapp-${rango.desde}-a-${rango.hasta}.csv`;
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        } catch (e: unknown) {
            toast({ title: 'No se pudo descargar el CSV', description: e instanceof Error ? e.message : undefined, variant: 'destructive' });
        } finally {
            setDescargando(false);
        }
    };

    const abrir = onAbrirConversacion;
    const propsFila = (f: FilaSeguimiento) => abrir ? {
        role: 'button' as const,
        tabIndex: 0,
        onClick: () => abrir(f.conversacionId),
        onKeyDown: (e: KeyboardEvent) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); abrir(f.conversacionId); }
        },
        'aria-label': `Abrir la conversación con ${f.contacto.nombre || telefonoLegible(f.contacto.telefono)}`,
    } : {};
    const tonoFila = (f: FilaSeguimiento) => f.alerta
        ? 'bg-red-50/80 hover:bg-red-100/70 dark:bg-red-950/25 dark:hover:bg-red-950/40 border-l-4 border-l-red-500'
        : 'hover:bg-muted/50 border-l-4 border-l-transparent';

    const servicios = datos?.servicios ?? [];

    const filtros = (
        <div className="flex flex-wrap items-end gap-3">
            <div className="inline-flex rounded-md border p-0.5" role="group" aria-label="Periodo">
                {RANGOS.map((n) => {
                    const r = rangoUltimosDias(n);
                    const activo = r.desde === rango.desde && r.hasta === rango.hasta;
                    return (
                        <Button key={n} size="sm" variant={activo ? 'default' : 'ghost'} className="h-8 px-3"
                            aria-pressed={activo} onClick={() => setRango(r)}>
                            {n} días
                        </Button>
                    );
                })}
            </div>
            <div className="flex items-end gap-2">
                <div className="space-y-1">
                    <Label htmlFor="seguimiento-desde" className="text-xs">Desde</Label>
                    <Input id="seguimiento-desde" type="date" className="h-9 w-[9.5rem]" value={rango.desde} max={rango.hasta}
                        onChange={(e) => e.target.value && setRango((r) => ({ ...r, desde: e.target.value }))} />
                </div>
                <div className="space-y-1">
                    <Label htmlFor="seguimiento-hasta" className="text-xs">Hasta</Label>
                    <Input id="seguimiento-hasta" type="date" className="h-9 w-[9.5rem]" value={rango.hasta} min={rango.desde}
                        onChange={(e) => e.target.value && setRango((r) => ({ ...r, hasta: e.target.value }))} />
                </div>
            </div>
            <div className="space-y-1">
                <Label className="text-xs">Tema</Label>
                <Select value={servicio} onValueChange={setServicio}>
                    <SelectTrigger className="h-9 w-[13rem]" aria-label="Tema o servicio"><SelectValue /></SelectTrigger>
                    <SelectContent>
                        <SelectItem value={TODOS}>Todos los temas</SelectItem>
                        {servicios.length > 0 && (
                            <>
                                <SelectSeparator />
                                <SelectGroup>
                                    <SelectLabel>Servicios</SelectLabel>
                                    <SelectItem value="servicio">Cualquier servicio</SelectItem>
                                    {servicios.map((s) => <SelectItem key={s.id} value={s.id}>{s.nombre}</SelectItem>)}
                                </SelectGroup>
                            </>
                        )}
                        <SelectSeparator />
                        {TEMAS_FIJOS.map((t) => <SelectItem key={t.valor} value={t.valor}>{t.texto}</SelectItem>)}
                    </SelectContent>
                </Select>
            </div>
            <div className="flex h-9 items-center gap-2">
                <Switch id="seguimiento-sin-responder" checked={soloSinResponder} onCheckedChange={setSoloSinResponder} />
                <Label htmlFor="seguimiento-sin-responder" className="text-sm">Solo sin responder</Label>
            </div>
            <div className="flex gap-2 sm:ml-auto">
                <Button size="icon" variant="outline" className="h-9 w-9" onClick={() => void cargar()}
                    disabled={cargando || !rangoValido} aria-label="Actualizar">
                    <RefreshCw className={`h-4 w-4 ${cargando ? 'animate-spin' : ''}`} />
                </Button>
                <Button variant="outline" className="h-9" onClick={() => void descargar()} disabled={descargando || !rangoValido || !datos}>
                    {descargando ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Download className="mr-1.5 h-4 w-4" />}
                    Descargar CSV
                </Button>
            </div>
            {!rangoValido && (
                <p className="w-full text-sm text-red-700 dark:text-red-400">
                    {rango.desde > rango.hasta ? 'La fecha «desde» va antes de «hasta».' : `El rango puede tener hasta ${DIAS_MAXIMO} días.`}
                </p>
            )}
        </div>
    );

    if (cargando && !datos) {
        return (
            <div className="space-y-4">
                {filtros}
                <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
                    {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-20" />)}
                </div>
                <Skeleton className="h-64" />
            </div>
        );
    }

    if (error || !datos) {
        return (
            <div className="space-y-4">
                {filtros}
                <Card>
                    <CardContent className="flex flex-col items-start gap-3 pt-6 text-sm">
                        <p className="flex items-center gap-2 font-medium">
                            <AlertTriangle className="h-4 w-4 text-orange-600" /> No se pudo cargar el seguimiento
                        </p>
                        <p className="text-muted-foreground">{error ?? 'No llegó respuesta del servidor.'}</p>
                        <Button variant="outline" size="sm" onClick={() => void cargar()} disabled={!rangoValido}>Reintentar</Button>
                    </CardContent>
                </Card>
            </div>
        );
    }

    const r = datos.resumen;
    const contadores: { titulo: string; valor: number; ayuda: string; rojo?: boolean }[] = [
        { titulo: 'Escribieron', valor: r.escribieron, ayuda: `en ${diasDelRango(datos.rango.desde, datos.rango.hasta)} días` },
        { titulo: 'Respondió la escuela', valor: r.respondioEscuela, ayuda: 'desde el celular o el buzón' },
        { titulo: 'Respondió el bot', valor: r.respondioBot, ayuda: r.nadieRespondio ? `${r.nadieRespondio} sin respuesta de nadie` : 'el asistente' },
        {
            titulo: 'Sin responder', valor: r.sinResponder, rojo: r.sinResponder > 0,
            ayuda: [r.esperandoMas2h ? `${r.esperandoMas2h} esperan > 2 h` : '', r.conPendientes ? `${r.conPendientes} con pendientes` : '']
                .filter(Boolean).join(' · ') || 'nadie esperando',
        },
        { titulo: 'Con comprobante', valor: r.conComprobante, ayuda: r.conDatosDePago ? `${r.conDatosDePago} recibieron datos de pago` : 'por WhatsApp' },
        { titulo: 'Con cobro', valor: r.conCobro, ayuda: 'en Gestión de Pagos' },
    ];

    return (
        <div className={`space-y-4 ${cargando ? 'opacity-60' : ''}`}>
            {filtros}

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                {contadores.map((c) => (
                    <Card key={c.titulo} className={c.rojo ? 'border-red-300 dark:border-red-900' : undefined}>
                        <CardContent className="p-4">
                            <p className="text-xs text-muted-foreground">{c.titulo}</p>
                            <p className={`text-2xl font-semibold tabular-nums ${c.rojo ? 'text-red-700 dark:text-red-400' : ''}`}>{c.valor}</p>
                            <p className="text-xs text-muted-foreground">{c.ayuda}</p>
                        </CardContent>
                    </Card>
                ))}
            </div>

            {datos.avisos.length > 0 && (
                <div className="flex gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:bg-amber-950/20">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                    <div className="space-y-1">{datos.avisos.map((a) => <p key={a}>{a}</p>)}</div>
                </div>
            )}

            {datos.filas.length === 0 ? (
                <Card>
                    <CardContent className="space-y-2 py-10 text-center text-sm text-muted-foreground">
                        <MessagesSquare className="mx-auto h-8 w-8 opacity-50" />
                        <p className="font-medium text-foreground">
                            {soloSinResponder ? 'Nadie está esperando respuesta en estas fechas. 🙌' : 'Nadie escribió en estas fechas.'}
                        </p>
                        <p className="mx-auto max-w-prose">
                            Aquí aparece cada persona que escribe al WhatsApp de la escuela: de qué tema, si le respondió la
                            escuela o el bot, y si quedó esperando.
                        </p>
                    </CardContent>
                </Card>
            ) : (
                <Card>
                    <CardHeader className="pb-2">
                        <CardTitle className="text-base">Conversaciones</CardTitle>
                        <CardDescription>
                            En rojo: lleva más de 2 horas esperando respuesta o tiene una pregunta que el bot le pasó a la
                            escuela y nadie contestó. «Automático» es el saludo o la respuesta rápida de WhatsApp Business:
                            no cuenta como respuesta.{abrir ? ' Toca una fila para abrir la conversación.' : ''}
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="p-0 sm:p-6 sm:pt-0">
                        {/* Escritorio: tabla */}
                        <div className="hidden overflow-x-auto md:block">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="border-b text-left text-xs text-muted-foreground">
                                        <th className="py-2 pl-3 pr-2 font-medium">Contacto</th>
                                        <th className="px-2 py-2 font-medium">Tema</th>
                                        <th className="px-2 py-2 font-medium">Primer mensaje</th>
                                        <th className="px-2 py-2 font-medium">Último mensaje</th>
                                        <th className="px-2 py-2 font-medium">Escuela</th>
                                        <th className="px-2 py-2 font-medium">Bot</th>
                                        <th className="px-2 py-2 font-medium">Esperando</th>
                                        <th className="px-2 py-2 font-medium">Pago</th>
                                        <th className="py-2 pl-2 pr-3 font-medium">Pendientes de la escuela</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {datos.filas.map((f) => (
                                        <tr key={f.conversacionId} data-alerta={f.alerta ? 'si' : 'no'} {...propsFila(f)}
                                            className={`border-b align-top last:border-b-0 ${tonoFila(f)} ${abrir ? 'cursor-pointer' : ''}`}>
                                            <td className="max-w-[12rem] py-3 pl-3 pr-2"><Contacto fila={f} /></td>
                                            <td className="max-w-[10rem] px-2 py-3 break-words">{f.tema.nombre}</td>
                                            <td className="max-w-[14rem] px-2 py-3">
                                                <p className="text-xs text-muted-foreground">{fechaCorta(f.primerMensaje.fecha)}</p>
                                                <p className="line-clamp-2 break-words">{f.primerMensaje.texto}</p>
                                            </td>
                                            <td className="max-w-[16rem] px-2 py-3">
                                                <div className="mb-0.5 flex items-center gap-1.5">
                                                    <DeQuien de={f.ultimoMensaje.de} />
                                                    <span className="text-xs text-muted-foreground">{fechaCorta(f.ultimoMensaje.fecha)}</span>
                                                </div>
                                                <p className="line-clamp-2 break-words">{f.ultimoMensaje.texto}</p>
                                            </td>
                                            <td className="px-2 py-3"><SiNo si={f.respondioEscuela} etiqueta="Respondió la escuela" /></td>
                                            <td className="px-2 py-3"><SiNo si={f.respondioBot} etiqueta="Respondió el bot" /></td>
                                            <td className="px-2 py-3"><Espera fila={f} /></td>
                                            <td className="max-w-[12rem] px-2 py-3"><Pago fila={f} /></td>
                                            <td className="max-w-[16rem] py-3 pl-2 pr-3"><Pendientes fila={f} /></td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>

                        {/* Celular: una tarjeta por conversación */}
                        <ul className="divide-y md:hidden">
                            {datos.filas.map((f) => (
                                <li key={f.conversacionId} data-alerta={f.alerta ? 'si' : 'no'} {...propsFila(f)}
                                    className={`space-y-2 p-4 ${tonoFila(f)} ${abrir ? 'cursor-pointer' : ''}`}>
                                    <div className="flex items-start justify-between gap-3">
                                        <Contacto fila={f} />
                                        <Badge variant="secondary" className="shrink-0 font-normal">{f.tema.nombre}</Badge>
                                    </div>
                                    <div className="text-sm">
                                        <div className="mb-0.5 flex flex-wrap items-center gap-1.5">
                                            <DeQuien de={f.ultimoMensaje.de} />
                                            <span className="text-xs text-muted-foreground">{fechaCorta(f.ultimoMensaje.fecha)}</span>
                                        </div>
                                        <p className="line-clamp-2 break-words">{f.ultimoMensaje.texto}</p>
                                    </div>
                                    <dl className="grid grid-cols-3 gap-2 text-xs">
                                        <div><dt className="text-muted-foreground">Escuela</dt><dd><SiNo si={f.respondioEscuela} etiqueta="Respondió la escuela" /></dd></div>
                                        <div><dt className="text-muted-foreground">Bot</dt><dd><SiNo si={f.respondioBot} etiqueta="Respondió el bot" /></dd></div>
                                        <div><dt className="text-muted-foreground">Esperando</dt><dd><Espera fila={f} /></dd></div>
                                    </dl>
                                    <Pago fila={f} />
                                    <Pendientes fila={f} />
                                </li>
                            ))}
                        </ul>
                    </CardContent>
                </Card>
            )}
        </div>
    );
}
