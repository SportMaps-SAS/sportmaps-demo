/**
 * WhatsApp › Campañas › Reporte de una campaña (fase F0.5 de
 * docs/specs/whatsapp-autoservicio-escuelas-2026-11-15.md).
 *
 * Para la dueña de la academia, sin tecnicismos: los números grandes arriba y
 * después «Lo que falta por salir» con fechas, «No se enviaron» con el motivo,
 * «Fallaron» con qué hacer y quién lo corrige, y «Qué tan cerca estás del
 * freno». Los textos vienen armados del BFF
 * (bff/src/services/whatsapp-campana-reporte.service.ts); aquí solo se pintan.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { bffClient } from '@/lib/api/bffClient';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Loader2, RefreshCw } from 'lucide-react';

// ─── Lo que devuelve el BFF ─────────────────────────────────────────────────

type Quien = 'escuela' | 'sportmaps';

export interface GrupoPorSalir {
    motivo: string; texto: string; cantidad: number; sale_desde_at: string | null; sale_hasta_at: string | null;
    cuando: string; despues_de_vencer: boolean;
}
export interface GrupoNoEnviado { motivo: string; texto: string; que_hacer: string; quien: Quien; requiere_accion: boolean; cantidad: number }
export interface GrupoFallido {
    clave: string; codigo: number | null; texto: string; que_hacer: string; quien: Quien; requiere_accion: boolean; cantidad: number;
}
export interface ReporteCampana {
    campana: {
        id: string; nombre: string; plantilla: string; estado: string;
        aprobada_at: string | null; vence_at: string | null; pausa_motivo: string | null; servicio_id: string | null;
    };
    generado_at: string;
    resumen: {
        destinatarios: number; enviados: number; entregados: number | null; leidos: number | null;
        respondieron: { si: number; luego: number; total: number };
        bajas_promos: number;
        pagaron: { cantidad: number; desde: string; hasta: string } | null;
    };
    por_salir: { total: number; en_horario_ahora: boolean; proxima_ventana_at: string; nota: string | null; grupos: GrupoPorSalir[] };
    no_enviados: { total: number; grupos: GrupoNoEnviado[] };
    fallidos: { total: number; grupos: GrupoFallido[] };
    inciertos: { cantidad: number; texto: string; que_hacer: string; quien: 'sportmaps' };
    freno: {
        enviados_24h: number; bajas_24h: number; fallidos_24h: number;
        bajas_que_faltan: number; fallos_que_faltan: number; en_el_limite: boolean; texto: string;
    } | null;
    lista_de_espera: null;
}

// ─── Textos ─────────────────────────────────────────────────────────────────

/** La etiqueta de cada grupo: quién lo corrige, o que no hay nada que hacer. */
export function etiquetaDeQuien(g: { quien: Quien; requiere_accion?: boolean }): string {
    if (g.quien === 'sportmaps') return 'Lo revisa SportMaps';
    return g.requiere_accion === false ? 'No tienes que hacer nada' : 'Lo puedes corregir tú';
}

const personas = (n: number) => (n === 1 ? '1 persona' : `${n} personas`);

const hora = (iso: string) => new Date(iso).toLocaleTimeString('es-CO', { timeZone: 'America/Bogota', hour: 'numeric', minute: '2-digit' });

// ─── Piezas ─────────────────────────────────────────────────────────────────

function Numero(p: { titulo: string; valor: number | null; nota?: string; testId: string }) {
    return (
        <div className="rounded-lg border p-3" data-testid={p.testId}>
            <p className="text-2xl font-semibold leading-tight tabular-nums">{p.valor === null ? '—' : p.valor}</p>
            <p className="text-xs text-muted-foreground">{p.titulo}</p>
            {(p.valor === null || p.nota) && (
                <p className="text-[11px] text-muted-foreground mt-0.5">{p.valor === null ? 'Sin dato todavía' : p.nota}</p>
            )}
        </div>
    );
}

function Seccion(p: { titulo: string; total?: number; children: ReactNode; testId: string }) {
    return (
        <section className="space-y-2" data-testid={p.testId}>
            <h3 className="text-sm font-semibold flex items-center gap-2">
                {p.titulo}
                {p.total !== undefined && <Badge variant="outline">{p.total}</Badge>}
            </h3>
            {p.children}
        </section>
    );
}

function Etiqueta({ g }: { g: { quien: Quien; requiere_accion?: boolean } }) {
    const texto = etiquetaDeQuien(g);
    return (
        <Badge variant={g.quien === 'sportmaps' ? 'outline' : g.requiere_accion === false ? 'secondary' : 'default'}
            className="whitespace-nowrap">
            {texto}
        </Badge>
    );
}

function Fila(p: { cantidad: number; texto: string; detalle?: string; pie?: string; etiqueta?: ReactNode }) {
    return (
        <li className="rounded-lg border p-3 space-y-1">
            <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
                <p className="text-sm min-w-0 flex-1 basis-48">
                    <strong className="tabular-nums">{p.cantidad}</strong> · {p.texto}
                </p>
                {p.etiqueta}
            </div>
            {p.detalle && <p className="text-xs text-muted-foreground">{p.detalle}</p>}
            {p.pie && <p className="text-[11px] text-muted-foreground">{p.pie}</p>}
        </li>
    );
}

// ─── Componente ─────────────────────────────────────────────────────────────

export function ReporteDeCampana(p: {
    schoolId: string;
    campanaId: string;
    /** Nombre de la campaña, para el título mientras carga. */
    nombre?: string;
    abierto: boolean;
    onCerrar: () => void;
}) {
    const [reporte, setReporte] = useState<ReporteCampana | null>(null);
    const [cargando, setCargando] = useState(false);
    const [error, setError] = useState(false);

    const url = `/api/v1/whatsapp/${p.schoolId}/campanas/${p.campanaId}/reporte`;

    const cargar = useCallback(async () => {
        setCargando(true);
        try {
            setReporte(await bffClient.get<ReporteCampana>(url));
            setError(false);
        } catch {
            setError(true);
        } finally {
            setCargando(false);
        }
    }, [url]);

    useEffect(() => {
        if (!p.abierto) return;
        setReporte(null);
        void cargar();
    }, [p.abierto, cargar]);

    const r = reporte;
    const fallaronTotal = r ? r.fallidos.total + r.inciertos.cantidad : 0;

    return (
        <Dialog open={p.abierto} onOpenChange={(v) => { if (!v) p.onCerrar(); }}>
            <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-2xl max-h-[90vh] overflow-y-auto">
                <DialogHeader>
                    <DialogTitle>Reporte de «{r?.campana.nombre ?? p.nombre ?? 'la campaña'}»</DialogTitle>
                    <DialogDescription>
                        {r ? `Con los datos de las ${hora(r.generado_at)}.` : 'Cómo va tu campaña, en números.'}
                    </DialogDescription>
                </DialogHeader>

                {!r && cargando && (
                    <div className="flex items-center justify-center py-10 text-muted-foreground" role="status">
                        <Loader2 className="h-5 w-5 mr-2 animate-spin" /> Armando el reporte…
                    </div>
                )}

                {!r && error && !cargando && (
                    <div className="py-6 text-center space-y-3">
                        <p className="text-sm text-muted-foreground">No pudimos cargar el reporte. Intenta de nuevo en un momento.</p>
                        <Button size="sm" variant="outline" onClick={() => void cargar()}>Reintentar</Button>
                    </div>
                )}

                {r && (
                    <div className="space-y-5 text-sm">
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                            <Numero testId="num-destinatarios" titulo="En la lista" valor={r.resumen.destinatarios} />
                            <Numero testId="num-enviados" titulo="Enviados" valor={r.resumen.enviados} />
                            <Numero testId="num-entregados" titulo="Les llegó" valor={r.resumen.entregados} />
                            <Numero testId="num-leidos" titulo="Lo leyeron" valor={r.resumen.leidos} />
                            <Numero testId="num-respondieron" titulo="Respondieron" valor={r.resumen.respondieron.total}
                                nota={`Sí: ${r.resumen.respondieron.si} · Más adelante: ${r.resumen.respondieron.luego}`} />
                            {r.campana.servicio_id && (
                                <Numero testId="num-pagaron" titulo="Pagaron o abonaron" valor={r.resumen.pagaron?.cantidad ?? null}
                                    nota="Desde que aprobaste la campaña" />
                            )}
                            <Numero testId="num-bajas" titulo="Pidieron no recibir más" valor={r.resumen.bajas_promos} />
                        </div>

                        <Seccion testId="sec-por-salir" titulo="Lo que falta por salir" total={r.por_salir.total}>
                            {r.por_salir.total === 0 && <p className="text-muted-foreground">No queda nada por salir.</p>}
                            {r.por_salir.nota && <p className="text-xs text-amber-700">{r.por_salir.nota}</p>}
                            {r.por_salir.grupos.length > 0 && (
                                <ul className="space-y-2">
                                    {r.por_salir.grupos.map((g) => (
                                        <Fila key={g.motivo} cantidad={g.cantidad} texto={g.texto}
                                            detalle={`Cuándo: ${g.cuando}.`}
                                            pie={g.despues_de_vencer ? 'La campaña cierra antes de esa fecha: no alcanzan a salir.' : undefined} />
                                    ))}
                                </ul>
                            )}
                            {r.por_salir.total > 0 && (
                                <p className="text-[11px] text-muted-foreground">
                                    Las campañas solo salen de lunes a viernes de 7 a. m. a 7 p. m. y los sábados de 8 a. m. a 3 p. m.
                                    Nunca en domingos ni festivos.
                                </p>
                            )}
                        </Seccion>

                        <Seccion testId="sec-no-enviados" titulo="No se enviaron" total={r.no_enviados.total}>
                            {r.no_enviados.total === 0
                                ? <p className="text-muted-foreground">A nadie de la lista se le dejó de enviar.</p>
                                : (
                                    <ul className="space-y-2">
                                        {r.no_enviados.grupos.map((g) => (
                                            <Fila key={g.motivo} cantidad={g.cantidad} texto={g.texto} detalle={g.que_hacer} etiqueta={<Etiqueta g={g} />} />
                                        ))}
                                    </ul>
                                )}
                        </Seccion>

                        <Seccion testId="sec-fallaron" titulo="Fallaron" total={fallaronTotal}>
                            {fallaronTotal === 0
                                ? <p className="text-muted-foreground">Ningún mensaje ha fallado.</p>
                                : (
                                    <ul className="space-y-2">
                                        {r.fallidos.grupos.map((g) => (
                                            <Fila key={g.clave} cantidad={g.cantidad} texto={g.texto} detalle={`Qué hacer: ${g.que_hacer}`}
                                                pie={g.codigo !== null ? `Código de Meta: ${g.codigo}` : undefined}
                                                etiqueta={<Etiqueta g={g} />} />
                                        ))}
                                        {r.inciertos.cantidad > 0 && (
                                            <Fila cantidad={r.inciertos.cantidad} texto={r.inciertos.texto} detalle={`Qué hacer: ${r.inciertos.que_hacer}`}
                                                etiqueta={<Etiqueta g={{ quien: 'sportmaps' }} />} />
                                        )}
                                    </ul>
                                )}
                        </Seccion>

                        <Seccion testId="sec-freno" titulo="Qué tan cerca estás del freno">
                            {r.freno === null
                                ? <p className="text-muted-foreground">No pudimos leer este dato ahora.</p>
                                : (
                                    <>
                                        <p className={r.freno.en_el_limite ? 'text-amber-700' : undefined}>{r.freno.texto}</p>
                                        {!r.freno.en_el_limite && (
                                            <div className="grid grid-cols-2 gap-2">
                                                <Numero testId="num-bajas-faltan" titulo="Personas más que pueden pedir «no recibir más» antes de la pausa" valor={r.freno.bajas_que_faltan} />
                                                <Numero testId="num-fallos-faltan" titulo="Mensajes más que pueden fallar antes de la pausa" valor={r.freno.fallos_que_faltan} />
                                            </div>
                                        )}
                                        <p className="text-[11px] text-muted-foreground">
                                            El freno cuida tu número: si muchas personas piden no recibir más o muchos mensajes fallan,
                                            tus campañas se pausan solas. Cuenta todas las campañas de tu número en las últimas 24 horas
                                            ({personas(r.freno.enviados_24h)}).
                                        </p>
                                    </>
                                )}
                        </Seccion>

                        <div className="flex justify-end">
                            <Button size="sm" variant="outline" disabled={cargando} onClick={() => void cargar()}>
                                {cargando ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-1" />}
                                Actualizar
                            </Button>
                        </div>
                    </div>
                )}
            </DialogContent>
        </Dialog>
    );
}
