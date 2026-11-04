/**
 * WhatsApp › Anuncios (fase 1 de docs/specs/whatsapp-anuncios-atribucion.md).
 *
 * Qué pasa después del clic en un anuncio de Facebook / Instagram con botón de
 * WhatsApp: por anuncio, cuántas conversaciones llegaron y cuántas contestaron
 * las preguntas, separaron o agendaron, pagaron (con el recaudo y su motivo),
 * asistieron y se matricularon. Cada conversación cuenta para el anuncio del
 * que LLEGÓ (primer toque); «volvieron» es aparte: los que ya habían llegado por
 * otro anuncio y este los trajo de vuelta.
 *
 * En cada anuncio, «este anuncio va a…» (clase de prueba, un servicio del
 * catálogo o una persona): es lo que el asistente hace con quien llega por ahí.
 * Sin definir, el asistente lo decide por el texto del anuncio.
 *
 * Datos: GET /api/v1/whatsapp/:schoolId/anuncios (embudo + mapeos + catálogo +
 * sedes); PUT / DELETE …/anuncios/:sourceId/destino. Las cuentas puras viven en
 * anunciosModelo.ts.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { bffClient } from '@/lib/api/bffClient';
import { useToast } from '@/hooks/use-toast';
import { formatCurrency } from '@/lib/utils';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
    Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { AlertTriangle, ExternalLink, Loader2, Megaphone, RefreshCw } from 'lucide-react';
import {
    ETAPAS, FILA_VACIA, SIN_DESTINO, aplicarMapeo, avisoHistorial, enlaceSeguro, mapeoDeValor, mapeosPorAnuncio,
    opcionesDeDestino, rangoUltimosDias, textoMotivo, textoPct, tituloDelAnuncio, valorDelSelector,
    type FilaEmbudo, type MapeoDestino, type ResumenAnuncios, type ServicioDelCatalogo,
} from './anunciosModelo';

const RANGOS = [7, 30, 90] as const;
const TODAS = 'todas';

// ─── Piezas ─────────────────────────────────────────────────────────────────

function Miniatura({ fila }: { fila: FilaEmbudo }) {
    const [rota, setRota] = useState(false);
    const src = enlaceSeguro(fila.media_url);
    if (!src || rota) {
        return (
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-muted" aria-hidden>
                <Megaphone className="h-4 w-4 text-muted-foreground" />
            </div>
        );
    }
    // La URL es del CDN de Meta y vence: si no carga, queda el ícono.
    return (
        <img src={src} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setRota(true)}
            className="h-10 w-10 shrink-0 rounded object-cover" />
    );
}

function NombreDelAnuncio({ fila }: { fila: FilaEmbudo }) {
    const url = enlaceSeguro(fila.source_url);
    return (
        <div className="flex min-w-0 items-start gap-2">
            <Miniatura fila={fila} />
            <div className="min-w-0">
                <p className="font-medium leading-tight break-words">{tituloDelAnuncio(fila)}</p>
                <p className="text-xs text-muted-foreground">
                    {fila.source_type === 'post' ? 'Publicación' : 'Anuncio'}
                    {fila.de_historial > 0 && ` · ${fila.de_historial} del historial`}
                    {url && (
                        <>
                            {' · '}
                            <a href={url} target="_blank" rel="noopener noreferrer"
                                className="inline-flex items-center gap-0.5 underline-offset-2 hover:underline">
                                ver <ExternalLink className="h-3 w-3" />
                            </a>
                        </>
                    )}
                </p>
            </div>
        </div>
    );
}

function Etapa({ valor, base }: { valor: number; base: number }) {
    return (
        <span className="tabular-nums">
            <span className="font-medium">{valor}</span>
            <span className="ml-1 text-xs text-muted-foreground">{textoPct(valor, base)}</span>
        </span>
    );
}

function Recaudo({ fila }: { fila: FilaEmbudo }) {
    return (
        <div className="space-y-0.5">
            <p className="font-medium tabular-nums">{fila.monto > 0 ? formatCurrency(fila.monto) : '—'}</p>
            {fila.pagos_por_motivo.map((m) => (
                <p key={`${m.motivo}:${m.servicio_id ?? ''}`} className="text-xs text-muted-foreground">
                    {textoMotivo(m)}: {m.pagos} · {formatCurrency(m.monto)}
                </p>
            ))}
        </div>
    );
}

function SelectorDestino({ sourceId, mapeo, servicios, ocupado, onCambiar }: {
    sourceId: string;
    mapeo: MapeoDestino | undefined;
    servicios: ServicioDelCatalogo[];
    ocupado: boolean;
    onCambiar: (sourceId: string, valor: string) => void;
}) {
    const opciones = opcionesDeDestino(servicios, mapeo);
    const fijas = opciones.filter((o) => o.grupo === 'fijo');
    const deServicio = opciones.filter((o) => o.grupo === 'servicio');
    return (
        <Select value={valorDelSelector(mapeo)} onValueChange={(v) => onCambiar(sourceId, v)} disabled={ocupado}>
            <SelectTrigger className="h-9 w-full min-w-[11rem] text-left" aria-label="Este anuncio va a">
                {ocupado ? <Loader2 className="h-4 w-4 animate-spin" /> : <SelectValue />}
            </SelectTrigger>
            <SelectContent>
                {fijas.map((o) => <SelectItem key={o.valor} value={o.valor}>{o.texto}</SelectItem>)}
                {deServicio.length > 0 && (
                    <>
                        <SelectSeparator />
                        <SelectGroup>
                            <SelectLabel>Servicio del catálogo</SelectLabel>
                            {deServicio.map((o) => <SelectItem key={o.valor} value={o.valor}>{o.texto}</SelectItem>)}
                        </SelectGroup>
                    </>
                )}
            </SelectContent>
        </Select>
    );
}

// ─── Componente ─────────────────────────────────────────────────────────────

export function Anuncios({ schoolId }: { schoolId: string }) {
    const { toast } = useToast();
    const [rango, setRango] = useState(() => rangoUltimosDias(30));
    const [sede, setSede] = useState<string>(TODAS);
    const [resumen, setResumen] = useState<ResumenAnuncios | null>(null);
    const [mapeos, setMapeos] = useState<MapeoDestino[]>([]);
    const [cargando, setCargando] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [guardando, setGuardando] = useState<string | null>(null);

    const base = `/api/v1/whatsapp/${schoolId}/anuncios`;

    const cargar = useCallback(async () => {
        setCargando(true);
        setError(null);
        try {
            const qs = new URLSearchParams({ desde: rango.desde, hasta: rango.hasta });
            if (sede !== TODAS) qs.set('sede', sede);
            const r = await bffClient.get<ResumenAnuncios>(`${base}?${qs.toString()}`);
            setResumen(r);
            setMapeos(r.mapeos ?? []);
        } catch (e: unknown) {
            setError(e instanceof Error ? e.message : 'Error desconocido');
        } finally {
            setCargando(false);
        }
    }, [base, rango.desde, rango.hasta, sede]);

    useEffect(() => { void cargar(); }, [cargar]);

    const porAnuncio = useMemo(() => mapeosPorAnuncio(mapeos), [mapeos]);
    const servicios = resumen?.servicios ?? [];

    const cambiarDestino = async (sourceId: string, valor: string) => {
        if (valor === valorDelSelector(porAnuncio.get(sourceId))) return;
        const cuerpo = mapeoDeValor(valor);
        setGuardando(sourceId);
        try {
            if (cuerpo) {
                const r = await bffClient.put<{ mapeo: MapeoDestino }>(
                    `${base}/${encodeURIComponent(sourceId)}/destino`, cuerpo);
                setMapeos((m) => aplicarMapeo(m, sourceId, r.mapeo));
            } else {
                await bffClient.delete(`${base}/${encodeURIComponent(sourceId)}/destino`);
                setMapeos((m) => aplicarMapeo(m, sourceId, null));
            }
            toast({ title: valor === SIN_DESTINO ? 'El asistente decidirá por el texto del anuncio' : 'Destino guardado' });
        } catch (e: any) {
            toast({ title: 'No se pudo guardar el destino', description: e?.message, variant: 'destructive' });
        } finally {
            setGuardando(null);
        }
    };

    const diasDelRango = Math.round((Date.parse(rango.hasta) - Date.parse(rango.desde)) / 86_400_000) + 1;

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
                    <Label htmlFor="anuncios-desde" className="text-xs">Desde</Label>
                    <Input id="anuncios-desde" type="date" className="h-9 w-[9.5rem]" value={rango.desde} max={rango.hasta}
                        onChange={(e) => e.target.value && setRango((r) => ({ ...r, desde: e.target.value }))} />
                </div>
                <div className="space-y-1">
                    <Label htmlFor="anuncios-hasta" className="text-xs">Hasta</Label>
                    <Input id="anuncios-hasta" type="date" className="h-9 w-[9.5rem]" value={rango.hasta} min={rango.desde}
                        onChange={(e) => e.target.value && setRango((r) => ({ ...r, hasta: e.target.value }))} />
                </div>
            </div>
            {(resumen?.sedes?.length ?? 0) > 1 && (
                <div className="space-y-1">
                    <Label className="text-xs">Sede</Label>
                    <Select value={sede} onValueChange={setSede}>
                        <SelectTrigger className="h-9 w-[11rem]" aria-label="Sede"><SelectValue /></SelectTrigger>
                        <SelectContent>
                            <SelectItem value={TODAS}>Todas las sedes</SelectItem>
                            {resumen!.sedes!.map((s) => <SelectItem key={s.id} value={s.id}>{s.nombre}</SelectItem>)}
                        </SelectContent>
                    </Select>
                </div>
            )}
            <Button size="icon" variant="outline" className="h-9 w-9" onClick={() => void cargar()}
                disabled={cargando} aria-label="Actualizar">
                <RefreshCw className={`h-4 w-4 ${cargando ? 'animate-spin' : ''}`} />
            </Button>
        </div>
    );

    if (cargando && !resumen) {
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

    if (error || !resumen) {
        return (
            <div className="space-y-4">
                {filtros}
                <Card>
                    <CardContent className="pt-6 flex flex-col items-start gap-3 text-sm">
                        <p className="flex items-center gap-2 font-medium">
                            <AlertTriangle className="h-4 w-4 text-orange-600" /> No se pudo cargar el embudo de anuncios
                        </p>
                        <p className="text-muted-foreground">{error ?? 'No llegó respuesta del servidor.'}</p>
                        <Button variant="outline" size="sm" onClick={() => void cargar()}>Reintentar</Button>
                    </CardContent>
                </Card>
            </div>
        );
    }

    if (!resumen.disponible) {
        return (
            <Card>
                <CardContent className="py-10 text-center text-sm text-muted-foreground">
                    <Megaphone className="mx-auto mb-2 h-8 w-8 opacity-50" />
                    El panel de anuncios todavía no está activo para tu escuela. SportMaps lo está terminando de instalar.
                </CardContent>
            </Card>
        );
    }

    const total = resumen.total ?? FILA_VACIA;
    const anuncios = resumen.anuncios ?? [];
    const aviso = avisoHistorial(total);
    const vacio = total.conversaciones === 0 && anuncios.length === 0;

    return (
        <div className={`space-y-4 ${cargando ? 'opacity-60' : ''}`}>
            {filtros}

            {vacio ? (
                <Card>
                    <CardContent className="py-10 text-center text-sm text-muted-foreground space-y-2">
                        <Megaphone className="mx-auto h-8 w-8 opacity-50" />
                        <p className="font-medium text-foreground">
                            Aún no hay conversaciones que lleguen de anuncios en estas fechas.
                        </p>
                        <p className="mx-auto max-w-prose">
                            Cuando alguien toque el botón de WhatsApp de un anuncio tuyo en Facebook o Instagram y te
                            escriba, aparece aquí con el anuncio del que vino y hasta dónde llegó: si contestó, separó,
                            pagó, asistió y se matriculó.
                        </p>
                    </CardContent>
                </Card>
            ) : (
                <>
                    {aviso && (
                        <div className="flex gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:bg-amber-950/20">
                            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                            <span>{aviso}</span>
                        </div>
                    )}

                    {/* ── Totales del periodo ── */}
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                        <Card>
                            <CardContent className="p-4">
                                <p className="text-xs text-muted-foreground">Conversaciones</p>
                                <p className="text-2xl font-semibold tabular-nums">{total.conversaciones}</p>
                                <p className="text-xs text-muted-foreground">en {diasDelRango} días</p>
                            </CardContent>
                        </Card>
                        {ETAPAS.map((e) => (
                            <Card key={e.clave} title={e.ayuda}>
                                <CardContent className="p-4">
                                    <p className="text-xs text-muted-foreground">{e.titulo}</p>
                                    <p className="text-2xl font-semibold tabular-nums">{total[e.clave]}</p>
                                    <p className="text-xs text-muted-foreground">
                                        {textoPct(total[e.clave], total.conversaciones)}
                                        {e.clave === 'pagaron' && total.monto > 0 && ` · ${formatCurrency(total.monto)}`}
                                    </p>
                                </CardContent>
                            </Card>
                        ))}
                    </div>

                    {total.pagos_por_motivo.length > 0 && (
                        <div className="flex flex-wrap gap-2 text-xs">
                            {total.pagos_por_motivo.map((m) => (
                                <Badge key={`${m.motivo}:${m.servicio_id ?? ''}`} variant="secondary" className="font-normal">
                                    {textoMotivo(m)}: {m.pagos} {m.pagos === 1 ? 'pago' : 'pagos'} · {formatCurrency(m.monto)}
                                </Badge>
                            ))}
                        </div>
                    )}

                    <Card>
                        <CardHeader className="pb-2">
                            <CardTitle className="text-base">Por anuncio</CardTitle>
                            <CardDescription>
                                Cada conversación cuenta para el anuncio del que llegó. «Volvieron»: ya habían llegado
                                por otro anuncio y este los trajo de nuevo. «Este anuncio va a» es lo que hace el
                                asistente con quien llega por ahí.
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="p-0 sm:p-6 sm:pt-0">
                            {/* Escritorio: tabla */}
                            <div className="hidden overflow-x-auto md:block">
                                <table className="w-full text-sm">
                                    <thead>
                                        <tr className="border-b text-left text-xs text-muted-foreground">
                                            <th className="py-2 pr-3 font-medium">Anuncio</th>
                                            <th className="px-2 py-2 font-medium text-right">Conversaciones</th>
                                            {ETAPAS.map((e) => (
                                                <th key={e.clave} className="px-2 py-2 font-medium text-right" title={e.ayuda}>{e.corto}</th>
                                            ))}
                                            <th className="px-2 py-2 font-medium">Recaudo</th>
                                            <th className="px-2 py-2 font-medium text-right">Volvieron</th>
                                            <th className="py-2 pl-2 font-medium">Este anuncio va a</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {anuncios.map((a) => (
                                            <tr key={a.source_id} className="border-b align-top last:border-0">
                                                <td className="max-w-[16rem] py-3 pr-3"><NombreDelAnuncio fila={a} /></td>
                                                <td className="px-2 py-3 text-right font-medium tabular-nums">{a.conversaciones}</td>
                                                {ETAPAS.map((e) => (
                                                    <td key={e.clave} className="px-2 py-3 text-right">
                                                        <Etapa valor={a[e.clave]} base={a.conversaciones} />
                                                    </td>
                                                ))}
                                                <td className="px-2 py-3"><Recaudo fila={a} /></td>
                                                <td className="px-2 py-3 text-right tabular-nums">{a.volvieron || '—'}</td>
                                                <td className="py-3 pl-2">
                                                    <SelectorDestino sourceId={a.source_id!} mapeo={porAnuncio.get(a.source_id!)}
                                                        servicios={servicios} ocupado={guardando === a.source_id}
                                                        onCambiar={(id, v) => void cambiarDestino(id, v)} />
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                    <tfoot>
                                        <tr className="border-t-2 font-medium">
                                            <td className="py-3 pr-3">Total</td>
                                            <td className="px-2 py-3 text-right tabular-nums">{total.conversaciones}</td>
                                            {ETAPAS.map((e) => (
                                                <td key={e.clave} className="px-2 py-3 text-right">
                                                    <Etapa valor={total[e.clave]} base={total.conversaciones} />
                                                </td>
                                            ))}
                                            <td className="px-2 py-3 tabular-nums">{total.monto > 0 ? formatCurrency(total.monto) : '—'}</td>
                                            <td className="px-2 py-3 text-right tabular-nums">{total.volvieron || '—'}</td>
                                            <td />
                                        </tr>
                                    </tfoot>
                                </table>
                            </div>

                            {/* Celular: una tarjeta por anuncio */}
                            <ul className="divide-y md:hidden">
                                {anuncios.map((a) => (
                                    <li key={a.source_id} className="space-y-3 p-4">
                                        <NombreDelAnuncio fila={a} />
                                        <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
                                            <div className="flex justify-between gap-2">
                                                <dt className="text-muted-foreground">Conversaciones</dt>
                                                <dd className="font-medium tabular-nums">{a.conversaciones}</dd>
                                            </div>
                                            {ETAPAS.map((e) => (
                                                <div key={e.clave} className="flex justify-between gap-2">
                                                    <dt className="text-muted-foreground">{e.corto}</dt>
                                                    <dd><Etapa valor={a[e.clave]} base={a.conversaciones} /></dd>
                                                </div>
                                            ))}
                                            {a.volvieron > 0 && (
                                                <div className="flex justify-between gap-2">
                                                    <dt className="text-muted-foreground">Volvieron</dt>
                                                    <dd className="tabular-nums">{a.volvieron}</dd>
                                                </div>
                                            )}
                                        </dl>
                                        {a.monto > 0 && <Recaudo fila={a} />}
                                        <div className="space-y-1">
                                            <p className="text-xs text-muted-foreground">Este anuncio va a</p>
                                            <SelectorDestino sourceId={a.source_id!} mapeo={porAnuncio.get(a.source_id!)}
                                                servicios={servicios} ocupado={guardando === a.source_id}
                                                onCambiar={(id, v) => void cambiarDestino(id, v)} />
                                        </div>
                                    </li>
                                ))}
                            </ul>
                        </CardContent>
                    </Card>
                </>
            )}
        </div>
    );
}
