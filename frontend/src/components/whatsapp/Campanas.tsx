/**
 * WhatsApp › Campañas (plan B5 T5, docs/specs/whatsapp-monster-plan-B5.md).
 *
 * Un mensaje de la escuela, UNA vez por persona, a quienes le escribieron por
 * WhatsApp preguntando por clases, inscripción o eventos (la audiencia la arma
 * el BFF con las reglas del bot). Con «Sí, cuéntame», «Más adelante» y «No
 * recibir más». Sale de a poco, en horario, y se frena solo si Meta baja la
 * calidad del número.
 *
 * La pantalla es simple a propósito: la tarjeta dice «Lista: N personas ·
 * [Aprobar y enviar]», con la declaración de responsabilidad en CADA
 * aprobación, y después el avance con Pausar / Reanudar.
 *
 * La escuela autogestiona sus campañas (spec whatsapp-autoservicio, 2026-11-15):
 * las ACTIVA ella misma aceptando la declaración, y si el sistema las pausa, las
 * reanuda viendo el motivo y aceptándolo. SportMaps solo pone las barreras
 * (topes, horarios, pausa automática) y un freno de emergencia que la escuela
 * no puede levantar.
 */
import { useCallback, useEffect, useState } from 'react';
import { bffClient } from '@/lib/api/bffClient';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { BarChart3, Loader2, Megaphone, Pause, Play, Plus, ShieldAlert } from 'lucide-react';
import { ReporteDeCampana } from './ReporteDeCampana';

// ─── Tipos que devuelve el BFF ──────────────────────────────────────────────

export interface Avance {
    total: number; pendiente: number; enviando: number; enviado: number; incierto: number; fallido: number;
    omitido: number; respondio_si: number; respondio_luego: number; baja: number;
}
export interface CampanaVista {
    id: string; nombre: string; plantilla: string;
    estado: 'borrador' | 'aprobada' | 'enviando' | 'pausada' | 'terminada' | 'cancelada';
    filtro: { intereses?: string[]; branch_ids?: string[] } | null;
    respuesta_si: string | null; destinatarios: number | null; aprobada_at: string | null; vence_at: string | null;
    pausa_motivo: string | null; conteo_previsto: number | null; avance: Avance | null;
    /** Servicio del catálogo que vende la campaña: quien ya lo pagó o abonó no la recibe. */
    servicio_id?: string | null; servicio_nombre?: string | null; ya_compraron?: number | null;
}
interface PlantillaMarketing {
    nombre: string; idioma: string; estado: string; lista: boolean; motivo: string | null; texto: string; botones: string[];
}
/**
 * Cupo de Meta del día (whatsapp-campanas-cupo del BFF): la campaña frena en
 * límite − reserva para que los avisos a los interesados que respondan sigan
 * saliendo. `usados_24h` null = no se pudo contar.
 */
export interface CupoCampanas {
    limite_meta: number; tier: string | null; fuente: 'graph' | 'evento' | 'por_defecto'; reserva: number;
    usados_24h: number | null; tope_diario: number; enviados_hoy: number; cupo_hoy: number; disponible_hoy: number;
}
export interface ResumenCampanas {
    disponible: boolean;
    habilitadas?: boolean;
    integracion?: string;
    cupo?: CupoCampanas | null;
    ajustes?: {
        base_consentimiento: string; tope_diario: number; lote_piloto: number; pausada: boolean; pausa_motivo: string | null;
        /** 'plataforma' = freno de emergencia de SportMaps: la escuela no lo levanta. */
        pausa_origen?: 'freno' | 'escuela' | 'plataforma' | null;
        /** Lo que la escuela acepta al reanudar tras la pausa automática. */
        aceptacion?: string | null;
    };
    /** Declaración que la escuela acepta para activar (apagadas, o prendidas sin haberla aceptado). */
    activacion?: { version: string; texto: string } | null;
    falta_activacion?: boolean;
    /** Freno global de SportMaps: ninguna escuela aprueba ni envía por ahora. */
    pausa_global?: boolean;
    audiencia?: { total: number; porInteres: Record<string, number>; porSede: Record<string, number> };
    sedes?: { id: string; nombre: string }[];
    servicios?: { id: string; nombre: string }[];
    plantillas?: PlantillaMarketing[];
    declaracion?: { version: string; texto: string } | null;
    campanas?: CampanaVista[];
}

// ─── Textos ─────────────────────────────────────────────────────────────────

export const INTERESES: { clave: string; texto: string }[] = [
    { clave: 'clase_prueba', texto: 'Clase de prueba' },
    { clave: 'inscripcion', texto: 'Inscripción' },
    { clave: 'clinica', texto: 'Clínica / vacacional' },
    { clave: 'precio', texto: 'Precios' },
    { clave: 'horarios', texto: 'Horarios' },
    { clave: 'informacion', texto: 'Información general' },
];
const TEXTO_INTERES = Object.fromEntries(INTERESES.map((i) => [i.clave, i.texto]));

const ESTADO: Record<CampanaVista['estado'], string> = {
    borrador: 'Borrador', aprobada: 'Aprobada', enviando: 'Enviando', pausada: 'En pausa', terminada: 'Terminada', cancelada: 'Cancelada',
};

/** Por qué está en pausa, en palabras de la escuela. */
export function motivoDePausa(m: string | null | undefined): string {
    const t: Record<string, string> = {
        manual: 'la pausaste tú',
        calidad_del_numero: 'Meta bajó la calidad de tu número',
        numero_marcado: 'Meta marcó tu número por la reacción de los destinatarios',
        calidad_de_plantilla: 'Meta bajó la calidad del mensaje',
        plantilla_no_aprobada: 'el mensaje ya no está aprobado por Meta',
        muchas_bajas: 'muchas personas pidieron no recibir más mensajes',
        muchos_fallos: 'muchos mensajes no se pudieron entregar',
        sin_integracion: 'tu número de WhatsApp está desconectado',
        escuela_en_pausa: 'las campañas de tu escuela están en pausa',
        pausa_de_plataforma: 'el equipo de SportMaps las pausó para proteger tu número',
    };
    return (m && t[m]) || 'revisa la campaña';
}

const ERRORES: Record<string, string> = {
    falta_declaracion: 'Falta confirmar la declaración.',
    plantilla_no_lista: 'Meta todavía no aprueba el mensaje. Cuando lo apruebe, vuelve y aprueba la campaña.',
    falta_interes: 'Elige al menos un interés: la campaña va a quienes preguntaron por ese tema, no a toda la lista.',
    campanas_apagadas: 'Las campañas están apagadas para tu escuela.',
    escuela_en_pausa: 'Tus campañas están en pausa.',
    no_es_borrador: 'Esta campaña ya fue aprobada.',
    falta_activacion: 'Primero activa las campañas aceptando la declaración.',
    falta_aceptacion: 'Marca que viste el motivo de la pausa.',
    solo_la_escuela: 'Esto solo lo puede hacer la administración de la escuela.',
    pausa_global: 'SportMaps pausó temporalmente todas las campañas. Te avisamos cuando vuelvan.',
    pausa_de_plataforma: 'El equipo de SportMaps pausó tus campañas. Escríbenos para revisarlo.',
    sin_destinatarios: 'Nadie de la lista puede recibir este mensaje ahora.',
};

/** Enviados hasta ahora (lo que ya salió, con o sin respuesta). */
export function enviadosDe(a: Avance | null | undefined): number {
    if (!a) return 0;
    return a.enviado + a.incierto + a.respondio_si + a.respondio_luego + a.baja;
}

/** «Cupo de hoy: X de Y · reserva Z para interesados y avisos». */
export function textoCupo(c: CupoCampanas): string {
    return `Cupo de hoy: ${c.disponible_hoy} de ${c.cupo_hoy} · reserva ${c.reserva} para interesados y avisos`;
}

/** El límite de Meta en palabras, con lo ya usado de la ventana de 24 h. */
export function textoLimiteMeta(c: CupoCampanas): string {
    const usados = c.usados_24h === null ? '' : ` · en las últimas 24 h: ${c.usados_24h}`;
    const supuesto = c.fuente === 'por_defecto' ? ' (Meta no lo informó: se asume el más bajo)' : '';
    return `Límite de Meta: ${c.limite_meta} personas distintas cada 24 h${supuesto}${usados}`;
}

/** El id de campaña de `?campana=<uuid>` en la dirección, o null. */
export function campanaDelEnlace(search: string = typeof window === 'undefined' ? '' : window.location.search): string | null {
    const id = new URLSearchParams(search).get('campana') ?? '';
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id : null;
}

// ─── Componente ─────────────────────────────────────────────────────────────

export function Campanas({ schoolId }: { schoolId: string }) {
    const { toast } = useToast();
    const [resumen, setResumen] = useState<ResumenCampanas | null>(null);
    const [error, setError] = useState(false);
    const [ocupado, setOcupado] = useState<string | null>(null);
    const [aprobando, setAprobando] = useState<string | null>(null);
    const [acepto, setAcepto] = useState(false);
    const [aceptoActivar, setAceptoActivar] = useState(false);
    const [aceptoMotivo, setAceptoMotivo] = useState(false);
    const [creando, setCreando] = useState(false);
    // Campaña cuyo reporte está abierto. `?campana=<id>` lo abre de una (el enlace del aviso al equipo de SportMaps).
    const [reporteDe, setReporteDe] = useState<string | null>(() => campanaDelEnlace());
    const [nueva, setNueva] = useState({ nombre: '', plantilla: '', intereses: [] as string[], respuestaSi: '', servicioId: '', venceAt: '' });

    const base = `/api/v1/whatsapp/${schoolId}/campanas`;

    const cargar = useCallback(async () => {
        try {
            setResumen(await bffClient.get<ResumenCampanas>(base));
            setError(false);
        } catch {
            setError(true);
        }
    }, [base]);

    useEffect(() => { void cargar(); }, [cargar]);

    const accion = async (id: string, que: 'pausar' | 'reanudar') => {
        setOcupado(id);
        try {
            await bffClient.post(`${base}/${id}/${que}`, {});
            toast({ title: que === 'pausar' ? 'Campaña en pausa' : 'Campaña reanudada' });
            await cargar();
        } catch (e: any) {
            toast({ title: 'No se pudo', description: e?.message, variant: 'destructive' });
        } finally {
            setOcupado(null);
        }
    };

    /** La escuela prende sus campañas aceptando la declaración (queda registrada con su usuario y la fecha). */
    const activar = async () => {
        setOcupado('activar');
        try {
            await bffClient.post(`${base}/activar`, { declaracion_aceptada: aceptoActivar });
            toast({ title: 'Campañas activadas', description: 'Ya puedes crear tu primera campaña.' });
            setAceptoActivar(false);
            await cargar();
        } catch (e: any) {
            toast({ title: 'No se pudieron activar', description: ERRORES[e?.body?.error] ?? e?.message, variant: 'destructive' });
        } finally {
            setOcupado(null);
        }
    };

    /** Levanta la pausa de la escuela (viendo y aceptando el motivo si la puso el sistema). */
    const reanudarEscuela = async () => {
        setOcupado('escuela');
        try {
            await bffClient.post(`${base}/reanudar-escuela`, { acepto_motivo: aceptoMotivo });
            toast({ title: 'Pausa levantada', description: 'Reanuda cada campaña cuando quieras.' });
            setAceptoMotivo(false);
            await cargar();
        } catch (e: any) {
            toast({ title: 'No se pudo reanudar', description: ERRORES[e?.body?.error] ?? e?.message, variant: 'destructive' });
        } finally {
            setOcupado(null);
        }
    };

    const aprobar = async (c: CampanaVista) => {
        setOcupado(c.id);
        try {
            const r = await bffClient.post<{ destinatarios: number }>(`${base}/${c.id}/aprobar`, { declaracion_aceptada: acepto });
            toast({
                title: `Aprobada para ${r.destinatarios} personas`,
                description: 'Sale de a poco y en horario. Te avisamos cuando alguien responda «Sí».',
            });
            setAprobando(null); setAcepto(false);
            await cargar();
        } catch (e: any) {
            toast({ title: 'No se pudo aprobar', description: ERRORES[e?.body?.error] ?? e?.message, variant: 'destructive' });
        } finally {
            setOcupado(null);
        }
    };

    const crear = async () => {
        setOcupado('nueva');
        try {
            await bffClient.post(base, {
                nombre: nueva.nombre, plantilla: nueva.plantilla,
                filtro: { intereses: nueva.intereses }, respuesta_si: nueva.respuestaSi || null,
                servicio_id: nueva.servicioId || null,
                // Fin del día elegido, hora de Bogotá: después de eso lo que falte ya no sale.
                vence_at: nueva.venceAt ? `${nueva.venceAt}T23:59:00-05:00` : null,
            });
            toast({ title: 'Campaña creada', description: 'Revisa la lista y apruébala cuando quieras.' });
            setCreando(false);
            setNueva({ nombre: '', plantilla: '', intereses: [], respuestaSi: '', servicioId: '', venceAt: '' });
            await cargar();
        } catch (e: any) {
            toast({ title: 'No se pudo crear', description: e?.message, variant: 'destructive' });
        } finally {
            setOcupado(null);
        }
    };

    if (error) {
        return <p className="text-sm text-muted-foreground py-6 text-center">No se pudieron cargar las campañas.</p>;
    }
    if (!resumen) {
        return <p className="text-sm text-muted-foreground py-6 text-center">Cargando campañas…</p>;
    }
    if (!resumen.disponible || !resumen.habilitadas) {
        return (
            <Card>
                <CardHeader>
                    <CardTitle className="text-base flex items-center gap-2"><Megaphone className="h-4 w-4" /> Campañas por WhatsApp</CardTitle>
                    <CardDescription>
                        Un mensaje, una sola vez, a quienes te preguntaron por clases, con la opción «No recibir más».
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                    {!resumen.disponible && <p className="text-sm text-muted-foreground">Todavía no están disponibles.</p>}
                    {resumen.disponible && resumen.activacion && (
                        <DeclaracionDeActivacion texto={resumen.activacion.texto} acepto={aceptoActivar} setAcepto={setAceptoActivar}
                            ocupado={ocupado !== null} onActivar={() => void activar()} />
                    )}
                </CardContent>
            </Card>
        );
    }
    if (resumen.integracion !== 'ok') {
        return <p className="text-sm text-muted-foreground py-6 text-center">Conecta tu número de WhatsApp para usar las campañas.</p>;
    }

    const campanas = resumen.campanas ?? [];
    const plantillas = resumen.plantillas ?? [];
    const listas = plantillas.filter((p) => p.lista);
    const audiencia = resumen.audiencia;

    return (
        <div className="space-y-4">
            {resumen.pausa_global && (
                <Card className="border-amber-300 bg-amber-50 dark:bg-amber-950/20">
                    <CardContent className="pt-6 flex gap-3 text-sm">
                        <ShieldAlert className="h-5 w-5 text-amber-600 shrink-0" />
                        <p><span className="font-medium">Las campañas están detenidas por SportMaps</span> para todas las escuelas, por
                            precaución. No se aprueba ni se envía nada hasta que las reactivemos; tus borradores no se pierden.</p>
                    </CardContent>
                </Card>
            )}

            {resumen.falta_activacion && resumen.activacion && (
                <Card data-testid="falta-activacion">
                    <CardHeader className="pb-2">
                        <CardTitle className="text-base">Antes de aprobar una campaña, acepta la declaración</CardTitle>
                        <CardDescription>Se acepta una sola vez. Queda registrada con tu usuario y la fecha.</CardDescription>
                    </CardHeader>
                    <CardContent>
                        <DeclaracionDeActivacion texto={resumen.activacion.texto} acepto={aceptoActivar} setAcepto={setAceptoActivar}
                            ocupado={ocupado !== null} onActivar={() => void activar()} />
                    </CardContent>
                </Card>
            )}

            {resumen.ajustes?.pausada && (
                <Card className="border-amber-300 bg-amber-50 dark:bg-amber-950/20" data-testid="pausa-escuela">
                    <CardContent className="pt-6 flex gap-3 text-sm">
                        <ShieldAlert className="h-5 w-5 text-amber-600 shrink-0" />
                        <div className="space-y-3">
                            <p>
                                <span className="font-medium">Tus campañas están en pausa</span> porque{' '}
                                {resumen.ajustes.pausa_origen === 'plataforma'
                                    ? motivoDePausa('pausa_de_plataforma')
                                    : motivoDePausa(resumen.ajustes.pausa_motivo)}. Así cuidamos tu número.
                            </p>
                            {resumen.ajustes.pausa_origen === 'plataforma' ? (
                                <p>Esta pausa solo la puede levantar SportMaps. Escríbenos y la revisamos contigo.</p>
                            ) : (
                                <>
                                    {resumen.ajustes.aceptacion && (
                                        <label className="flex items-start gap-2">
                                            <input type="checkbox" className="mt-1" checked={aceptoMotivo}
                                                onChange={(e) => setAceptoMotivo(e.target.checked)} aria-label="Vi el motivo de la pausa" />
                                            <span>{resumen.ajustes.aceptacion}</span>
                                        </label>
                                    )}
                                    <Button size="sm" disabled={ocupado !== null || (!!resumen.ajustes.aceptacion && !aceptoMotivo)}
                                        onClick={() => void reanudarEscuela()}>
                                        {ocupado === 'escuela' && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                                        <Play className="h-4 w-4 mr-1" /> Levantar la pausa
                                    </Button>
                                    <p className="text-xs text-muted-foreground">Después reanudas cada campaña con su botón «Reanudar».</p>
                                </>
                            )}
                        </div>
                    </CardContent>
                </Card>
            )}

            <Card>
                <CardHeader className="flex-row items-start justify-between space-y-0 gap-3">
                    <div>
                        <CardTitle className="text-base flex items-center gap-2"><Megaphone className="h-4 w-4" /> Campañas por WhatsApp</CardTitle>
                        <CardDescription>
                            {audiencia?.total ?? 0} personas te escribieron pidiendo información y todavía no son del club.
                            Cada una recibe un solo mensaje, con «No recibir más».
                        </CardDescription>
                    </div>
                    <Button variant="outline" onClick={() => setCreando((v) => !v)}>
                        <Plus className="h-4 w-4 mr-1" /> Nueva campaña
                    </Button>
                </CardHeader>
                <CardContent className="space-y-3">
                    {resumen.cupo && (
                        <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm" data-testid="cupo-campanas"
                            title="La campaña se detiene antes del límite de Meta para que los avisos a los interesados que respondan (clase de prueba, cupos, pagos) sigan saliendo. Retoma sola cuando se libera la ventana.">
                            <p className="font-medium">{textoCupo(resumen.cupo)}</p>
                            <p className="text-xs text-muted-foreground">{textoLimiteMeta(resumen.cupo)}</p>
                        </div>
                    )}

                    {audiencia && Object.keys(audiencia.porInteres).length > 0 && (
                        <div className="flex flex-wrap gap-2">
                            {Object.entries(audiencia.porInteres).sort((a, b) => b[1] - a[1]).map(([k, v]) => (
                                <Badge key={k} variant="secondary">{TEXTO_INTERES[k] ?? k}: {v}</Badge>
                            ))}
                        </div>
                    )}

                    {creando && (
                        <div className="border rounded-lg p-4 space-y-3 bg-muted/30">
                            <div>
                                <Label htmlFor="campana-nombre">Nombre</Label>
                                <Input id="campana-nombre" value={nueva.nombre} placeholder="Cierre de año"
                                    onChange={(e) => setNueva({ ...nueva, nombre: e.target.value })} />
                            </div>
                            <div>
                                <Label htmlFor="campana-plantilla">Mensaje (plantilla aprobada por Meta)</Label>
                                <select id="campana-plantilla" className="w-full border rounded-md h-10 px-2 bg-background text-sm"
                                    value={nueva.plantilla} onChange={(e) => setNueva({ ...nueva, plantilla: e.target.value })}>
                                    <option value="">Elige un mensaje…</option>
                                    {listas.map((p) => <option key={p.nombre} value={p.nombre}>{p.nombre}</option>)}
                                </select>
                                {listas.length === 0 && (
                                    <p className="text-xs text-muted-foreground mt-1">
                                        No tienes mensajes de promoción aprobados. Créalos en la pestaña Plantillas (marcando «Es una promoción»).
                                    </p>
                                )}
                                {nueva.plantilla && (
                                    <p className="text-xs text-muted-foreground mt-1 whitespace-pre-wrap">
                                        {listas.find((p) => p.nombre === nueva.plantilla)?.texto}
                                    </p>
                                )}
                            </div>
                            <div>
                                <Label>¿A quiénes?</Label>
                                <div className="flex flex-wrap gap-2 mt-1">
                                    {INTERESES.map((i) => {
                                        const marcado = nueva.intereses.includes(i.clave);
                                        return (
                                            <Button key={i.clave} type="button" size="sm" variant={marcado ? 'default' : 'outline'}
                                                onClick={() => setNueva({
                                                    ...nueva,
                                                    intereses: marcado ? nueva.intereses.filter((x) => x !== i.clave) : [...nueva.intereses, i.clave],
                                                })}>
                                                {i.texto}
                                            </Button>
                                        );
                                    })}
                                </div>
                                <p className="text-xs text-muted-foreground mt-1">Sin marcar ninguno, va a todos.</p>
                            </div>
                            {(resumen.servicios?.length ?? 0) > 0 && (
                                <div>
                                    <Label htmlFor="campana-servicio">¿Vende un servicio de tu catálogo?</Label>
                                    <select id="campana-servicio" className="w-full border rounded-md h-10 px-2 bg-background text-sm"
                                        value={nueva.servicioId} onChange={(e) => setNueva({ ...nueva, servicioId: e.target.value })}>
                                        <option value="">No, es una campaña general</option>
                                        {resumen.servicios!.map((s) => <option key={s.id} value={s.id}>{s.nombre}</option>)}
                                    </select>
                                    <p className="text-xs text-muted-foreground mt-1">
                                        Si eliges uno, quien ya lo pagó o abonó no recibe la campaña.
                                    </p>
                                </div>
                            )}
                            <div>
                                <Label htmlFor="campana-vence">¿Hasta qué día vale? (opcional)</Label>
                                <Input id="campana-vence" type="date" value={nueva.venceAt}
                                    onChange={(e) => setNueva({ ...nueva, venceAt: e.target.value })} />
                                <p className="text-xs text-muted-foreground mt-1">
                                    Ponla si el mensaje tiene fecha límite: pasado ese día, lo que falte por enviar ya no sale.
                                </p>
                            </div>
                            <div>
                                <Label htmlFor="campana-si">Lo que respondes cuando tocan «Sí»</Label>
                                <Textarea id="campana-si" rows={3} value={nueva.respuestaSi} maxLength={1024}
                                    placeholder="¡Genial! Te cuento: …"
                                    onChange={(e) => setNueva({ ...nueva, respuestaSi: e.target.value })} />
                                <p className="text-xs text-muted-foreground mt-1">Sale apenas la persona toca «Sí». Si lo dejas vacío, te avisamos para que le escribas tú.</p>
                            </div>
                            <Button onClick={() => void crear()} disabled={ocupado !== null || nueva.nombre.trim().length < 3 || !nueva.plantilla}>
                                {ocupado === 'nueva' && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                                Crear borrador
                            </Button>
                        </div>
                    )}

                    {campanas.length === 0 && !creando && (
                        <p className="text-sm text-muted-foreground py-4 text-center">Todavía no hay campañas.</p>
                    )}
                </CardContent>
            </Card>

            {campanas.map((c) => {
                const enviados = enviadosDe(c.avance);
                const total = c.destinatarios ?? c.avance?.total ?? 0;
                const plantilla = plantillas.find((p) => p.nombre === c.plantilla);
                return (
                    <Card key={c.id} data-testid={`campana-${c.id}`}>
                        <CardHeader className="pb-2">
                            <CardTitle className="text-base flex items-center gap-2">
                                {c.nombre}
                                <Badge variant={c.estado === 'pausada' ? 'destructive' : 'outline'}>{ESTADO[c.estado]}</Badge>
                            </CardTitle>
                            <CardDescription className="font-mono text-xs">{c.plantilla}</CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-3 text-sm">
                            {c.estado === 'borrador' && (
                                <>
                                    <div className="flex flex-wrap items-center justify-between gap-2">
                                        <div>
                                            <span className="font-medium">Lista: {c.conteo_previsto ?? 0} personas</span>
                                            {!!c.ya_compraron && (
                                                <p className="text-xs text-muted-foreground">
                                                    {c.ya_compraron} ya pagaron o abonaron {c.servicio_nombre ?? 'el servicio'} y no la reciben.
                                                </p>
                                            )}
                                            {c.vence_at && (
                                                <p className="text-xs text-muted-foreground">
                                                    Vale hasta el {new Date(c.vence_at).toLocaleDateString('es-CO', { timeZone: 'America/Bogota' })}.
                                                </p>
                                            )}
                                        </div>
                                        <Button size="sm" disabled={ocupado !== null || !c.conteo_previsto || plantilla?.lista === false
                                            || !!resumen.falta_activacion || !!resumen.pausa_global || !!resumen.ajustes?.pausada}
                                            onClick={() => { setAprobando(aprobando === c.id ? null : c.id); setAcepto(false); }}>
                                            Aprobar y enviar
                                        </Button>
                                    </div>
                                    {plantilla && !plantilla.lista && (
                                        <p className="text-xs text-amber-700">El mensaje todavía no está listo: {plantilla.motivo}</p>
                                    )}
                                    {aprobando === c.id && (
                                        <div className="border rounded-lg p-3 space-y-3 bg-muted/30">
                                            {resumen.declaracion && (
                                                <label className="flex items-start gap-2 text-sm">
                                                    <input type="checkbox" className="mt-1" checked={acepto}
                                                        onChange={(e) => setAcepto(e.target.checked)} aria-label="Confirmo la declaración" />
                                                    <span>{resumen.declaracion.texto}</span>
                                                </label>
                                            )}
                                            <p className="text-xs text-muted-foreground">
                                                Sale de a poco y solo en horario: el primer día {resumen.ajustes?.lote_piloto} personas,
                                                luego hasta {resumen.cupo?.cupo_hoy ?? resumen.ajustes?.tope_diario} por día
                                                {resumen.cupo ? `, siempre dejando ${resumen.cupo.reserva} para los avisos a los interesados` : ''}.
                                                Si Meta baja la calidad de tu número, se pausa sola.
                                            </p>
                                            <Button size="sm" disabled={ocupado !== null || (!!resumen.declaracion && !acepto)}
                                                onClick={() => void aprobar(c)}>
                                                {ocupado === c.id && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                                                Aprobar y enviar a {c.conteo_previsto} personas
                                            </Button>
                                        </div>
                                    )}
                                </>
                            )}

                            {c.estado !== 'borrador' && (
                                <>
                                    <div>
                                        <div className="flex justify-between text-xs text-muted-foreground mb-1">
                                            <span>Enviados {enviados} de {total}</span>
                                            {c.avance && c.avance.pendiente > 0 && <span>{c.avance.pendiente} por enviar</span>}
                                        </div>
                                        <div className="h-2 rounded bg-muted overflow-hidden">
                                            <div className="h-full bg-primary" style={{ width: `${total ? Math.min(100, Math.round((enviados / total) * 100)) : 0}%` }} />
                                        </div>
                                    </div>
                                    <p>
                                        Sí: <strong>{c.avance?.respondio_si ?? 0}</strong> · Más adelante: <strong>{c.avance?.respondio_luego ?? 0}</strong>
                                        {' '}· No recibir más: <strong>{c.avance?.baja ?? 0}</strong>
                                        {(c.avance?.fallido ?? 0) > 0 && <> · No entregados: <strong>{c.avance?.fallido}</strong></>}
                                    </p>
                                    {c.estado === 'pausada' && (
                                        <p className="text-xs text-amber-700">En pausa porque {motivoDePausa(c.pausa_motivo)}.</p>
                                    )}
                                    {(c.estado === 'aprobada' || c.estado === 'enviando') && (
                                        <Button size="sm" variant="outline" disabled={ocupado !== null} onClick={() => void accion(c.id, 'pausar')}>
                                            <Pause className="h-4 w-4 mr-1" /> Pausar
                                        </Button>
                                    )}
                                    {c.estado === 'pausada' && (
                                        <Button size="sm" disabled={ocupado !== null || !!resumen.ajustes?.pausada || !!resumen.pausa_global}
                                            title={resumen.ajustes?.pausada ? 'Primero levanta la pausa de la escuela (arriba).' : undefined}
                                            onClick={() => void accion(c.id, 'reanudar')}>
                                            <Play className="h-4 w-4 mr-1" /> Reanudar
                                        </Button>
                                    )}
                                    {(c.estado === 'aprobada' || c.estado === 'enviando' || c.estado === 'pausada' || c.estado === 'terminada') && (
                                        <Button size="sm" variant="outline" className={c.estado === 'terminada' ? undefined : 'ml-2'}
                                            onClick={() => setReporteDe(c.id)}>
                                            <BarChart3 className="h-4 w-4 mr-1" /> Ver reporte
                                        </Button>
                                    )}
                                </>
                            )}
                        </CardContent>
                    </Card>
                );
            })}

            {reporteDe && (
                <ReporteDeCampana schoolId={schoolId} campanaId={reporteDe} abierto
                    nombre={campanas.find((c) => c.id === reporteDe)?.nombre} onCerrar={() => setReporteDe(null)} />
            )}
        </div>
    );
}

/** La declaración de responsabilidad que la escuela acepta UNA vez para usar campañas. */
function DeclaracionDeActivacion(p: {
    texto: string; acepto: boolean; setAcepto: (v: boolean) => void; ocupado: boolean; onActivar: () => void;
}) {
    return (
        <div className="border rounded-lg p-3 space-y-3 bg-muted/30 text-sm">
            <label className="flex items-start gap-2">
                <input type="checkbox" className="mt-1" checked={p.acepto}
                    onChange={(e) => p.setAcepto(e.target.checked)} aria-label="Acepto la declaración de responsabilidad" />
                <span>{p.texto}</span>
            </label>
            <Button size="sm" disabled={p.ocupado || !p.acepto} onClick={p.onActivar}>Aceptar y activar campañas</Button>
        </div>
    );
}
