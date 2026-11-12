/**
 * Metricas — ¿el asistente de WhatsApp sirve? Tablero por escuela.
 *
 * Lee GET /api/v1/whatsapp/:schoolId/metricas (bff/src/routes/whatsapp-metricas.routes.ts).
 * Las definiciones de cada número están en bff/src/services/whatsapp-metricas.ts;
 * acá solo se muestran. Hasta el 2026-10-04 el bot no tenía ninguna medición:
 * se veía cuánto se gastaba en Meta, no si resolvía algo.
 *
 * Mobile first: las tarjetas van de a 2 columnas en el celular y la gráfica
 * ocupa el ancho completo con altura fija.
 */

import { useCallback, useEffect, useState } from 'react';
import {
    CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { bffClient } from '@/lib/api/bffClient';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { AlertTriangle, BarChart3, RefreshCw } from 'lucide-react';

// ─── Contrato del BFF ───────────────────────────────────────────────────────

interface PuntoSerie { dia: string; entrantes: number; bot: number; humano: number; automatico: number; otro: number }
export interface MetricasWhatsApp {
    conectado: boolean;
    rango?: { desde: string; hasta: string; dias: number };
    clasificacion_disponible?: boolean;
    conversaciones?: { activas: number; por_tipo: Record<string, number> };
    familias?: {
        activas: number; solo_bot: number; escaladas: number; atendidas_por_persona: number; sin_respuesta: number;
        pct_solo_bot: number | null; pct_escaladas: number | null;
        primera_respuesta_humana: { muestras: number; mediana_seg: number | null; p90_seg: number | null };
        pendientes_ahora: number; sin_responder_mas_24h: number;
    };
    comprobantes?: {
        recibidos: number; aplicados_solos: number; aprobados_por_la_escuela: number; esperando_revision: number;
        rechazados: number; para_la_escuela: number; escalados: number; fallidos: number; esperando_familia: number;
        ignorados: number; en_proceso: number; motivos_ignorados: { motivo: string; n: number }[];
    };
    consentimientos?: {
        activos: number; bajas: number; nuevos_en_rango: number;
        familias_con_conversacion: number; familias_identificadas: number; pct_sobre_familias: number | null;
    };
    prospectos?: {
        atendidos: number; inscripcion: number; pagos: number; sin_enlace: number;
        dejaron_datos: number; se_inscribieron: number; cruce: 'telefono';
    };
    totales_mensajes?: { entrantes: number; bot: number; humano: number; automatico: number; otro: number };
    serie?: PuntoSerie[];
    avisos?: string[];
}

const RANGOS = [7, 30, 90] as const;

const NOMBRE_TIPO: Record<string, string> = {
    familia: 'Familias', familia_sin_cuenta: 'Familias sin cuenta', ambiguo: 'Número en dos cuentas',
    staff: 'Equipo de la escuela', desconocido: 'Desconocidos', personal: 'Personales', negocio: 'Negocios', otro_club: 'Otros clubes',
    plataforma: 'Plataformas', equipo: 'Staff (marcado)', sin_clasificar: 'Sin clasificar',
};

/** Segundos → «45 s», «12 min», «3,5 h», «2,1 días». */
function duracion(seg: number | null | undefined): string {
    if (seg === null || seg === undefined) return '—';
    if (seg < 60) return `${seg} s`;
    if (seg < 3600) return `${Math.round(seg / 60)} min`;
    if (seg < 86400) return `${(seg / 3600).toFixed(1).replace('.', ',')} h`;
    return `${(seg / 86400).toFixed(1).replace('.', ',')} días`;
}

const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${String(v).replace('.', ',')}%`);
const diaCorto = (d: string) => {
    const [, m, dd] = d.split('-');
    return `${Number(dd)}/${Number(m)}`;
};

function Kpi({ titulo, valor, detalle, alerta }: { titulo: string; valor: string | number; detalle?: string; alerta?: boolean }) {
    return (
        <Card className={alerta ? 'border-orange-300' : undefined}>
            <CardHeader className="p-4 pb-1">
                <CardDescription className="text-xs leading-tight">{titulo}</CardDescription>
            </CardHeader>
            <CardContent className="p-4 pt-0">
                <div className="text-2xl font-bold tabular-nums">{valor}</div>
                {detalle && <p className="text-xs text-muted-foreground leading-snug mt-0.5">{detalle}</p>}
            </CardContent>
        </Card>
    );
}

export function Metricas({ schoolId }: { schoolId: string }) {
    const [dias, setDias] = useState<(typeof RANGOS)[number]>(30);
    const [datos, setDatos] = useState<MetricasWhatsApp | null>(null);
    const [cargando, setCargando] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const cargar = useCallback(async () => {
        setCargando(true);
        setError(null);
        try {
            const desde = new Date(Date.now() - dias * 24 * 3600_000).toISOString();
            const r = await bffClient.get<MetricasWhatsApp>(
                `/api/v1/whatsapp/${schoolId}/metricas?desde=${encodeURIComponent(desde)}`);
            setDatos(r);
        } catch (e: unknown) {
            setError(e instanceof Error ? e.message : 'Error desconocido');
        } finally {
            setCargando(false);
        }
    }, [schoolId, dias]);

    useEffect(() => { void cargar(); }, [cargar]);

    const selector = (
        <div className="flex items-center gap-2">
            <div className="inline-flex rounded-md border p-0.5" role="group" aria-label="Periodo">
                {RANGOS.map((n) => (
                    <Button key={n} size="sm" variant={dias === n ? 'default' : 'ghost'}
                        className="h-8 px-3" aria-pressed={dias === n} onClick={() => setDias(n)}>
                        {n} días
                    </Button>
                ))}
            </div>
            <Button size="icon" variant="outline" className="h-9 w-9" onClick={() => void cargar()}
                disabled={cargando} aria-label="Actualizar">
                <RefreshCw className={`h-4 w-4 ${cargando ? 'animate-spin' : ''}`} />
            </Button>
        </div>
    );

    if (cargando && !datos) {
        return (
            <div className="space-y-4">
                {selector}
                <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                    {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-24" />)}
                </div>
                <Skeleton className="h-64" />
            </div>
        );
    }

    if (error || !datos) {
        return (
            <div className="space-y-4">
                {selector}
                <Card>
                    <CardContent className="pt-6 flex flex-col items-start gap-3 text-sm">
                        <p className="flex items-center gap-2 font-medium">
                            <AlertTriangle className="h-4 w-4 text-orange-600" /> No se pudieron cargar las métricas
                        </p>
                        <p className="text-muted-foreground">{error ?? 'No llegó respuesta del servidor.'}</p>
                        <Button variant="outline" size="sm" onClick={() => void cargar()}>Reintentar</Button>
                    </CardContent>
                </Card>
            </div>
        );
    }

    const f = datos.familias;
    const c = datos.comprobantes;
    const o = datos.consentimientos;
    const p = datos.prospectos;
    const serie = datos.serie ?? [];
    const sinActividad = !datos.conectado || ((datos.totales_mensajes?.entrantes ?? 0) === 0 && (c?.recibidos ?? 0) === 0);

    return (
        <div className={`space-y-4 ${cargando ? 'opacity-60' : ''}`}>
            {selector}

            {(datos.avisos ?? []).map((a) => (
                <div key={a} className="flex gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:bg-amber-950/20">
                    <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 mt-0.5" />
                    <span>{a}</span>
                </div>
            ))}

            {sinActividad ? (
                <Card>
                    <CardContent className="py-10 text-center text-sm text-muted-foreground">
                        <BarChart3 className="mx-auto mb-2 h-8 w-8 opacity-50" />
                        No hubo mensajes ni comprobantes en los últimos {dias} días.
                    </CardContent>
                </Card>
            ) : (
                <>
                    {/* ── Familias: lo que dice si el bot sirve ── */}
                    <section className="space-y-2">
                        <h3 className="text-sm font-semibold">Familias que escribieron</h3>
                        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                            <Kpi titulo="Resueltas solo por Mapi" valor={pct(f?.pct_solo_bot)}
                                detalle={`${f?.solo_bot ?? 0} de ${f?.activas ?? 0} conversaciones`} />
                            <Kpi titulo="Pasadas a una persona" valor={pct(f?.pct_escaladas)}
                                detalle={`${f?.escaladas ?? 0} escaladas · ${f?.atendidas_por_persona ?? 0} contestadas directo`} />
                            <Kpi titulo="Primera respuesta de una persona"
                                valor={duracion(f?.primera_respuesta_humana.mediana_seg)}
                                detalle={f?.primera_respuesta_humana.muestras
                                    ? `mediana · 9 de cada 10 en menos de ${duracion(f.primera_respuesta_humana.p90_seg)}`
                                    : 'todavía sin respuestas para medir'} />
                            <Kpi titulo="Sin responder hace más de 24 h" valor={f?.sin_responder_mas_24h ?? 0}
                                alerta={(f?.sin_responder_mas_24h ?? 0) > 0}
                                detalle={`${f?.pendientes_ahora ?? 0} esperan respuesta ahora`} />
                        </div>
                    </section>

                    {/* ── Gráfica diaria ── */}
                    <Card>
                        <CardHeader className="p-4 pb-2">
                            <CardTitle className="text-base">Mensajes por día</CardTitle>
                            <CardDescription>
                                Entrantes y respuestas: de Mapi o de una persona (celular de la escuela o
                                buzón). Los saludos automáticos del celular no cuentan como respuesta.
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="p-2 pt-0 sm:p-4 sm:pt-0">
                            {/* Colores: slots 1-3 de la paleta categórica validada (azul, naranja, aqua),
                                con su paso oscuro propio en modo oscuro. */}
                            <div className="h-64 w-full [--wa-ent:#2a78d6] [--wa-bot:#eb6834] [--wa-hum:#1baf7a]
                                dark:[--wa-ent:#3987e5] dark:[--wa-bot:#d95926] dark:[--wa-hum:#199e70]">
                                <ResponsiveContainer width="100%" height="100%">
                                    <LineChart data={serie} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                                        <CartesianGrid strokeDasharray="3 3" vertical={false} className="stroke-muted" />
                                        <XAxis dataKey="dia" tickFormatter={diaCorto} tick={{ fontSize: 11 }}
                                            minTickGap={16} className="fill-muted-foreground" />
                                        <YAxis allowDecimals={false} tick={{ fontSize: 11 }} width={40} />
                                        <Tooltip labelFormatter={(d: string) => diaCorto(d)}
                                            contentStyle={{ fontSize: 12 }} />
                                        <Legend wrapperStyle={{ fontSize: 12 }} />
                                        <Line type="linear" dataKey="entrantes" name="Entrantes" stroke="var(--wa-ent)"
                                            strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
                                        <Line type="linear" dataKey="bot" name="Mapi" stroke="var(--wa-bot)"
                                            strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
                                        <Line type="linear" dataKey="humano" name="Persona" stroke="var(--wa-hum)"
                                            strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
                                    </LineChart>
                                </ResponsiveContainer>
                            </div>
                            <details className="mt-2 px-2 text-sm">
                                <summary className="cursor-pointer text-muted-foreground">Ver tabla</summary>
                                <div className="mt-2 max-h-60 overflow-auto">
                                    <table className="w-full text-xs tabular-nums">
                                        <thead className="text-muted-foreground">
                                            <tr><th className="text-left py-1">Día</th><th className="text-right">Entrantes</th>
                                                <th className="text-right">Mapi</th><th className="text-right">Persona</th>
                                                <th className="text-right">Automáticos</th></tr>
                                        </thead>
                                        <tbody>
                                            {serie.map((s) => (
                                                <tr key={s.dia} className="border-t">
                                                    <td className="py-1">{diaCorto(s.dia)}</td><td className="text-right">{s.entrantes}</td>
                                                    <td className="text-right">{s.bot}</td><td className="text-right">{s.humano}</td>
                                                    <td className="text-right">{s.automatico}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            </details>
                        </CardContent>
                    </Card>

                    {/* ── Comprobantes ── */}
                    <section className="space-y-2">
                        <h3 className="text-sm font-semibold">Comprobantes recibidos por el chat</h3>
                        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                            <Kpi titulo="Recibidos" valor={c?.recibidos ?? 0}
                                detalle={c?.en_proceso ? `${c.en_proceso} todavía en proceso` : undefined} />
                            <Kpi titulo="Aplicados solos" valor={c?.aplicados_solos ?? 0}
                                detalle={`${c?.aprobados_por_la_escuela ?? 0} aprobados luego por la escuela`} />
                            <Kpi titulo="Para la escuela" valor={c?.para_la_escuela ?? 0}
                                alerta={(c?.para_la_escuela ?? 0) > 0}
                                detalle={`${c?.esperando_revision ?? 0} por revisar · ${c?.escalados ?? 0} escalados · ${c?.fallidos ?? 0} con error`} />
                            <Kpi titulo="Ignorados" valor={c?.ignorados ?? 0}
                                detalle={c?.motivos_ignorados?.length
                                    ? c.motivos_ignorados.slice(0, 2).map((m) => `${m.motivo} (${m.n})`).join(' · ')
                                    : undefined} />
                        </div>
                    </section>

                    {/* ── Consentimientos y prospectos ── */}
                    <section className="space-y-2">
                        <h3 className="text-sm font-semibold">Consentimientos y prospectos</h3>
                        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                            <Kpi titulo="Familias que aceptan avisos" valor={o?.activos ?? 0}
                                detalle={`${pct(o?.pct_sobre_familias)} de ${o?.familias_con_conversacion ?? 0} familias con chat · ${o?.nuevos_en_rango ?? 0} nuevas`} />
                            <Kpi titulo="Dadas de baja" valor={o?.bajas ?? 0} />
                            <Kpi titulo="Prospectos atendidos" valor={p?.atendidos ?? 0}
                                detalle={`${p?.inscripcion ?? 0} por inscripción · ${p?.pagos ?? 0} por pagos`} />
                            <Kpi titulo="Prospectos que se inscribieron" valor={p?.se_inscribieron ?? 0}
                                detalle={`${p?.dejaron_datos ?? 0} dejaron sus datos · cruce por teléfono`} />
                        </div>
                    </section>

                    {/* ── Quién escribe ── */}
                    {datos.conversaciones && datos.conversaciones.activas > 0 && (
                        <Card>
                            <CardHeader className="p-4 pb-2">
                                <CardTitle className="text-base">Quién escribió</CardTitle>
                                <CardDescription>{datos.conversaciones.activas} conversaciones con mensajes en el periodo</CardDescription>
                            </CardHeader>
                            <CardContent className="p-4 pt-0">
                                <ul className="divide-y text-sm">
                                    {Object.entries(datos.conversaciones.por_tipo)
                                        .filter(([, n]) => n > 0)
                                        .sort((a, b) => b[1] - a[1])
                                        .map(([k, n]) => (
                                            <li key={k} className="flex justify-between py-1.5">
                                                <span>{NOMBRE_TIPO[k] ?? k}</span>
                                                <span className="tabular-nums font-medium">{n}</span>
                                            </li>
                                        ))}
                                </ul>
                            </CardContent>
                        </Card>
                    )}
                </>
            )}
        </div>
    );
}
