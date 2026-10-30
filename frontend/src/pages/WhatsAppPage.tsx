/**
 * WhatsAppPage — el canal de WhatsApp de la escuela.
 *
 * Cuatro cosas que hasta ahora solo se veían consultando la base a mano:
 *
 *  · Estado y consumo del mes, con el aviso al 80% de lo incluido.
 *  · Plantillas de Meta con su estado y categoría. Importa porque si Meta
 *    desactiva o recategoriza una plantilla de cobranza, los envíos dejan de
 *    salir y el primer síntoma sería que nadie paga.
 *  · Bandeja: los comprobantes que llegaron y quedaron sin resolver, agrupados
 *    (requiere acción / para revisar / informativo). Ver BandejaComprobantes.
 *  · Configuración: modo, IA y horario de atención.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useSchoolContext } from '@/hooks/useSchoolContext';
import { bffClient } from '@/lib/api/bffClient';
import { supabase } from '@/integrations/supabase/client';
import { type ResultadoDelAlta } from '@/components/whatsapp/ConectarNumero';
import { AltaDelCanal } from '@/components/whatsapp/AltaDelCanal';
import { Conversaciones } from '@/components/whatsapp/Conversaciones';
import { HorariosDeEntrenamiento } from '@/components/whatsapp/HorariosDeEntrenamiento';
import { Metricas } from '@/components/whatsapp/Metricas';
import { ClasesCortesia } from '@/components/whatsapp/ClasesCortesia';
import { AvisosSportMaps } from '@/components/whatsapp/AvisosSportMaps';
import { ImportarChatExportado } from '@/components/whatsapp/ImportarChatExportado';
import { BandejaComprobantes, type ResumenBandeja } from '@/components/whatsapp/BandejaComprobantes';
import { Campanas } from '@/components/whatsapp/Campanas';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import {
    MessageSquare, RefreshCw, AlertTriangle, Clock, FileText, Inbox, Settings, Plus, Loader2, Power, BarChart3, CalendarCheck,
    Megaphone,
} from 'lucide-react';

// ─── Tipos que devuelve el BFF ──────────────────────────────────────────────

interface Consumo {
    facturables: number; gratis: number; sin_estado: number;
    por_categoria: Record<string, number>;
    incluidos: number; restantes: number; excedente: number; avisar: boolean;
}
interface Ajustes {
    mode: 'auto' | 'assisted';
    ai_enabled: boolean;
    /** Contestar también a números que no son familias. Ausente si el backend es viejo. */
    responder_desconocidos?: boolean;
    /** Contestar a desconocidos que piden información para inscribirse. Ausente = prendido. */
    responder_prospectos?: boolean;
    business_hours: { tz: string; dias: Record<string, [string, string]> } | null;
    welcome_message: string | null;
}
interface Estado {
    conectado: boolean;
    integracion: { display_phone_number: string | null; waba_id: string | null; status: string } | null;
    ajustes: Ajustes | null;
    consumo: Consumo | null;
    bandeja?: FilaBandeja[];
    /** Conteo por grupo. Ausente si el BFF es anterior al 2026-10-07. */
    bandeja_resumen?: ResumenBandeja;
    eventos?: EventoMeta[];
    /** Borradores `pending` que quedaron de un rato en asistido (solo en modo auto). */
    borradores_huerfanos?: Huerfanos;
}
interface Huerfanos { conversaciones: number; borradores: number }
interface Plantilla {
    name: string; status: string; category: string; language: string;
}
/** Plantilla del catálogo de SportMaps (bff/whatsapp-templates), lista para registrar en Meta. */
interface PlantillaCatalogo {
    name: string; language: string; category: string; texto: string; ejemplos: string[]; boton: string | null;
}
interface FilaBandeja {
    id: string; status: string; wa_phone_number: string; message_type: string;
    error_message: string | null; created_at: string;
}
interface EventoMeta {
    id: string; field: string; template_name: string | null;
    estado_previo: string | null; nuevo_estado: string | null; motivo: string | null; created_at: string;
}

const DIAS = [
    ['1', 'Lunes'], ['2', 'Martes'], ['3', 'Miércoles'], ['4', 'Jueves'],
    ['5', 'Viernes'], ['6', 'Sábado'], ['0', 'Domingo'],
] as const;

/** Verde solo lo aprobado: el estado de una plantilla decide si la cobranza sale. */
function tonoDeEstado(estado: string): string {
    if (estado === 'APPROVED') return 'bg-green-100 text-green-700 border-green-200';
    if (estado === 'PENDING') return 'bg-amber-100 text-amber-700 border-amber-200';
    return 'bg-red-100 text-red-700 border-red-200';
}

export default function WhatsAppPage() {
    const { schoolId } = useSchoolContext();
    // El correo de escalamiento enlaza a ?tab=conversaciones&conversacion=<id>:
    // abre la pestaña y la conversación directo, sin buscarla en la lista.
    const [searchParams] = useSearchParams();
    const conversacionInicial = searchParams.get('conversacion');
    const pestanaInicial = searchParams.get('tab') || (conversacionInicial ? 'conversaciones' : 'resumen');
    const { toast } = useToast();

    const [estado, setEstado] = useState<Estado | null>(null);
    const [plantillas, setPlantillas] = useState<Plantilla[]>([]);
    const [bandeja, setBandeja] = useState<FilaBandeja[]>([]);
    const [resumenBandeja, setResumenBandeja] = useState<ResumenBandeja | null>(null);
    // «Ver chat» desde la bandeja: abre esa conversación en su pestaña.
    const [conversacionAbrir, setConversacionAbrir] = useState<string | null>(conversacionInicial);
    // Sube al importar un chat: remonta la bandeja para que relea.
    const [versionBandeja, setVersionBandeja] = useState(0);
    const [eventos, setEventos] = useState<EventoMeta[]>([]);
    const [cargando, setCargando] = useState(true);
    const [cargandoPlantillas, setCargandoPlantillas] = useState(false);
    // Lo que devuelve el diálogo de Meta, mientras se canjea contra el BFF.
    const [alta, setAlta] = useState<ResultadoDelAlta | null>(null);
    const [conectando, setConectando] = useState(false);
    const [errorDeCarga, setErrorDeCarga] = useState<string | null>(null);
    const [guardando, setGuardando] = useState(false);
    const [pestana, setPestana] = useState(pestanaInicial);
    const [respondiendo, setRespondiendo] = useState(false);
    const tiraPestanas = useRef<HTMLDivElement>(null);

    // El «Chat» de la barra de abajo enlaza a ?tab=conversaciones: si ya se
    // está en /whatsapp, el cambio de query tiene que mover la pestaña.
    const tabDeUrl = searchParams.get('tab');
    useEffect(() => { if (tabDeUrl) setPestana(tabDeUrl); }, [tabDeUrl]);

    // En el celular las pestañas se deslizan: la elegida (y su contador) se trae a la vista.
    useEffect(() => {
        const activa = tiraPestanas.current?.querySelector<HTMLElement>('[role="tab"][data-state="active"]');
        activa?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    }, [pestana]);

    const cargar = useCallback(async () => {
        if (!schoolId) return;
        setCargando(true);
        setErrorDeCarga(null);
        try {
            // Una sola llamada trae estado, bandeja y eventos: los tres salen de
            // la misma base y antes costaban tres verificaciones de permisos.
            const e = await bffClient.get<Estado>(`/api/v1/whatsapp/${schoolId}`);
            setEstado(e);
            setBandeja(e.bandeja ?? []);
            setResumenBandeja(e.bandeja_resumen ?? null);
            setEventos(e.eventos ?? []);
        } catch (err: any) {
            setErrorDeCarga(err?.message ?? 'Error desconocido');
            toast({ title: 'No se pudo cargar', description: err?.message ?? 'Error', variant: 'destructive' });
        } finally {
            setCargando(false);
        }
    }, [schoolId, toast]);

    // Las plantillas las responde Meta, no nuestra base: ~650 ms que no tienen
    // por que retener el resto de la pantalla. Van aparte y con su propio spinner.
    const cargarPlantillas = useCallback(async () => {
        if (!schoolId) return;
        setCargandoPlantillas(true);
        try {
            const r = await bffClient.get<{ plantillas: Plantilla[] }>(
                `/api/v1/whatsapp/${schoolId}/plantillas`);
            setPlantillas(r.plantillas ?? []);
        } catch {
            // Que Meta no responda no deja la pantalla inservible: el resto ya cargo.
        } finally {
            setCargandoPlantillas(false);
        }
    }, [schoolId]);

    /**
     * Canjea contra el BFF lo que devolvió el diálogo.
     *
     * El código vence en minutos y es de un solo uso, así que se manda de
     * inmediato y no se guarda en ningún lado del navegador.
     */
    const conectar = useCallback(async (r: ResultadoDelAlta) => {
        setAlta(r);
        setConectando(true);
        try {
            const res = await bffClient.post<{ display_phone_number: string | null; coexistence: boolean }>(
                `/api/v1/whatsapp/${schoolId}/conectar`, {
                    code: r.code,
                    // `event` dice si fue Coexistence (y con eso el BFF pide el
                    // historial); antes solo iba `data` y el BFF nunca lo veía.
                    sesion: r.sesion?.data ? { event: r.sesion.event, ...r.sesion.data } : null,
                });
            toast({
                title: 'WhatsApp conectado',
                description: res.coexistence
                    ? `${res.display_phone_number ?? 'El número'} quedó conectado y sigue funcionando en tu celular.`
                    : `${res.display_phone_number ?? 'El número'} quedó conectado.`,
            });
            setAlta(null);
            await cargar();
        } catch (e: any) {
            toast({ title: 'No se pudo conectar', description: e?.message ?? 'Error', variant: 'destructive' });
        } finally {
            setConectando(false);
        }
    }, [schoolId, cargar, toast]);

    useEffect(() => { void cargar(); }, [cargar]);
    useEffect(() => { void cargarPlantillas(); }, [cargarPlantillas]);

    const guardarAjustes = async (cambios: Partial<Ajustes>) => {
        if (!schoolId) return;
        setGuardando(true);
        try {
            const { borradores_huerfanos: huerfanos, ...r } = await bffClient.patch<Ajustes & { borradores_huerfanos?: Huerfanos }>(
                `/api/v1/whatsapp/${schoolId}/settings`, cambios);
            setEstado((e) => (e ? { ...e, ajustes: r, borradores_huerfanos: huerfanos ?? e.borradores_huerfanos } : e));
            toast({ title: 'Guardado' });
        } catch (err: any) {
            toast({ title: 'No se pudo guardar', description: err?.message ?? 'Error', variant: 'destructive' });
        } finally {
            setGuardando(false);
        }
    };

    // Al volver a automático los borradores del rato en asistido no se mandan
    // solos (ver PATCH /settings): «Responder ahora» le pide al BFF que conteste
    // esas conversaciones con el bot de HOY (no reenvía el borrador viejo).
    const responderAhora = async () => {
        if (!schoolId) return;
        setRespondiendo(true);
        try {
            await bffClient.post(`/api/v1/whatsapp/${schoolId}/ponerse-al-dia`, { solo_borradores: true });
            setEstado((e) => (e ? { ...e, borradores_huerfanos: { conversaciones: 0, borradores: 0 } } : e));
            toast({ title: 'Respondiendo', description: 'Mapi está contestando esas conversaciones. Tarda uno o dos minutos.' });
        } catch (err: any) {
            toast({ title: 'No se pudo', description: err?.message ?? 'Error', variant: 'destructive' });
        } finally {
            setRespondiendo(false);
        }
    };

    const consumo = estado?.consumo;
    // El contador es lo que requiere acción, no todo lo que el bot no aplicó.
    const pendientesBandeja = resumenBandeja ? resumenBandeja.accion : bandeja.length;
    const verChat = (id: string) => { setConversacionAbrir(id); setPestana('conversaciones'); };
    const porcentaje = useMemo(() => {
        if (!consumo?.incluidos) return 0;
        return Math.min(Math.round((consumo.facturables / consumo.incluidos) * 100), 100);
    }, [consumo]);

    if (cargando && !estado) {
        return <div className="p-8 flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Cargando el canal…
        </div>;
    }

    if (errorDeCarga || !estado) {
        return (
            <div className="p-6 max-w-2xl">
                <Card>
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                            <MessageSquare className="h-5 w-5" /> No se pudo cargar el canal
                        </CardTitle>
                        <CardDescription>
                            {errorDeCarga ?? 'No llegó respuesta del servidor.'}
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        <Button variant="outline" onClick={() => void cargar()}>
                            <RefreshCw className="h-4 w-4 mr-2" /> Reintentar
                        </Button>
                    </CardContent>
                </Card>
            </div>
        );
    }

    if (estado && !estado.conectado) {
        return (
            <AltaDelCanal
                onListo={(r) => void conectar(r)}
                conectando={conectando}
                avisoSinCoexistence={Boolean(alta && !alta.esCoexistence)}
            />
        );
    }

    return (
        // Celular: el layout ya pone 12 px a los lados; con px-1 queda el margen
        // de 16 px del estándar (antes p-6 + layout = ~36 px por lado).
        <div className="px-1 sm:px-0 space-y-4 md:space-y-6">
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <h1 className="text-xl md:text-2xl font-bold flex items-center gap-2">
                        <MessageSquare className="h-5 w-5 md:h-6 md:w-6" /> WhatsApp
                    </h1>
                    <p className="text-sm md:text-base text-muted-foreground truncate">
                        {estado?.integracion?.display_phone_number ?? 'Sin número'} · canal de atención y cobranza
                    </p>
                </div>
                <Button variant="outline" onClick={() => void cargar()} disabled={cargando}
                        className="shrink-0 w-touch h-touch p-0 md:w-auto md:h-10 md:px-4" aria-label="Actualizar">
                    <RefreshCw className={`h-4 w-4 md:mr-2 ${cargando ? 'animate-spin' : ''}`} />
                    <span className="hidden md:inline">Actualizar</span>
                </Button>
            </div>

            {/* EL ASISTENTE APAGADO ES EL PRIMER AVISO, arriba de todos los demas.

                Un canal recien conectado arranca con Mapi apagada a proposito
                (ver whatsapp-onboarding.service.ts): conectar el numero y
                prender el bot son dos decisiones distintas. Pero apagado y sin
                avisar es peor que prendido — la escuela cree que esta
                respondiendo y nadie contesta. Asi que el estado se dice, y el
                boton para prenderlo esta en el mismo aviso: si hay que ir a
                buscarlo a otra pestana, alguien no lo encuentra. */}
            {estado?.ajustes && estado.ajustes.ai_enabled === false && (
                <Card className="border-sky-300 bg-sky-50 dark:bg-sky-950/20">
                    <CardContent className="pt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
                        <Power className="h-5 w-5 text-sky-600 shrink-0" />
                        <div className="text-sm flex-1">
                            <p className="font-medium">Mapi todavia no esta respondiendo</p>
                            <p className="text-muted-foreground">
                                El numero ya quedo conectado y los mensajes llegan a
                                <strong> Conversaciones</strong>, pero los contesta una persona.
                                Antes de prenderlo revisa <strong>Horarios</strong>: lo que este
                                cargado ahi es lo que el bot le va a decir a las familias.
                            </p>
                        </div>
                        <Button
                            onClick={() => void guardarAjustes({ ai_enabled: true })}
                            disabled={guardando}
                            className="shrink-0"
                        >
                            {guardando
                                ? <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                                : <Power className="h-4 w-4 mr-2" />}
                            Prender a Mapi
                        </Button>
                    </CardContent>
                </Card>
            )}
            {/* El modo asistido se avisa arriba: con el bot en asistido responde
                pero NADA sale hasta que alguien aprueba cada mensaje. Es la
                confusión más cara de este módulo. */}
            {estado?.ajustes?.mode === 'assisted' && estado.ajustes.ai_enabled !== false && (
                <Card className="border-amber-300 bg-amber-50 dark:bg-amber-950/20">
                    <CardContent className="pt-6 flex gap-3">
                        <AlertTriangle className="h-5 w-5 text-amber-600 shrink-0" />
                        <div className="text-sm">
                            <p className="font-medium">El bot está en modo asistido</p>
                            <p className="text-muted-foreground">
                                Prepara las respuestas pero <strong>no las envía</strong>: alguien de la escuela
                                tiene que aprobar cada una. Si esperas que responda solo, cámbialo a automático
                                en Configuración.
                            </p>
                        </div>
                    </CardContent>
                </Card>
            )}

            {estado?.ajustes?.mode === 'auto' && (estado.borradores_huerfanos?.borradores ?? 0) > 0 && (
                <Card className="border-amber-300 bg-amber-50 dark:bg-amber-950/20">
                    <CardContent className="pt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
                        <AlertTriangle className="h-5 w-5 text-amber-600 shrink-0" />
                        <div className="text-sm flex-1">
                            <p className="font-medium">
                                Quedan {estado.borradores_huerfanos!.borradores} borradores sin enviar
                                en {estado.borradores_huerfanos!.conversaciones} conversaciones
                            </p>
                            <p className="text-muted-foreground">
                                Se prepararon mientras el bot estaba en modo asistido y nadie los aprobó.
                                Ahora que responde solo, nadie los va a mandar: esas familias siguen esperando.
                            </p>
                        </div>
                        <div className="flex gap-2 shrink-0">
                            <Button onClick={() => void responderAhora()} disabled={respondiendo}>
                                {respondiendo && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                                Enviar todos
                            </Button>
                            <Button variant="outline" onClick={() => setPestana('conversaciones')}>Revisar</Button>
                        </div>
                    </CardContent>
                </Card>
            )}

            {consumo?.avisar && (
                <Card className="border-orange-300 bg-orange-50 dark:bg-orange-950/20">
                    <CardContent className="pt-6 flex gap-3">
                        <AlertTriangle className="h-5 w-5 text-orange-600 shrink-0" />
                        <div className="text-sm">
                            <p className="font-medium">Vas por {consumo.facturables} de {consumo.incluidos} mensajes incluidos</p>
                            <p className="text-muted-foreground">
                                No se corta nada: si te pasas, el excedente se cobra como paquete adicional.
                                Te avisamos para que no te tome por sorpresa.
                            </p>
                        </div>
                    </CardContent>
                </Card>
            )}

            <Tabs value={pestana} onValueChange={setPestana}>
                {/* Con ocho pestañas la fila no cabe en un celular: se desliza de lado,
                    sin barra y con los bordes desvanecidos. Lo del día a día va primero
                    (Conversaciones y Bandeja, con su contador), para que se vea sin deslizar. */}
                <TabsList ref={tiraPestanas} className="w-full justify-start h-tabs md:h-10 scroll-fade-x">
                    <TabsTrigger value="resumen" className="h-full">Resumen</TabsTrigger>
                    <TabsTrigger value="conversaciones" className="h-full">
                        <MessageSquare className="h-4 w-4 mr-1.5" />
                        {/* «Chats» en el celular: así la Bandeja y su contador caben sin deslizar. */}
                        <span className="md:hidden">Chats</span><span className="hidden md:inline">Conversaciones</span>
                    </TabsTrigger>
                    <TabsTrigger value="bandeja" className="h-full">
                        <Inbox className="h-4 w-4 mr-1" /> Bandeja
                        {pendientesBandeja > 0 && <Badge variant="secondary" className="ml-2">{pendientesBandeja}</Badge>}
                    </TabsTrigger>
                    <TabsTrigger value="cortesias" className="h-full">
                        <CalendarCheck className="h-4 w-4 mr-1" /> Clases de cortesía
                    </TabsTrigger>
                    <TabsTrigger value="plantillas" className="h-full">
                        <FileText className="h-4 w-4 mr-1" /> Plantillas
                    </TabsTrigger>
                    <TabsTrigger value="campanas" className="h-full">
                        <Megaphone className="h-4 w-4 mr-1" /> Campañas
                    </TabsTrigger>
                    <TabsTrigger value="metricas" className="h-full">
                        <BarChart3 className="h-4 w-4 mr-1" /> Métricas
                    </TabsTrigger>
                    <TabsTrigger value="horarios" className="h-full">
                        <Clock className="mr-1 h-3.5 w-3.5" /> Horarios
                    </TabsTrigger>
                    <TabsTrigger value="config" className="h-full">
                        <Settings className="h-4 w-4 mr-1" /> Configuración
                    </TabsTrigger>
                </TabsList>

                {/* ── Resumen ── */}
                <TabsContent value="resumen" className="space-y-4">
                    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                        <Card>
                            <CardHeader className="pb-2"><CardDescription>Mensajes facturables</CardDescription></CardHeader>
                            <CardContent>
                                <div className="text-2xl font-bold">{consumo?.facturables ?? 0}</div>
                                <p className="text-xs text-muted-foreground">de {consumo?.incluidos ?? 0} incluidos · {porcentaje}%</p>
                            </CardContent>
                        </Card>
                        <Card>
                            <CardHeader className="pb-2"><CardDescription>Sin costo</CardDescription></CardHeader>
                            <CardContent>
                                <div className="text-2xl font-bold">{consumo?.gratis ?? 0}</div>
                                <p className="text-xs text-muted-foreground">respuestas dentro de las 24 h</p>
                            </CardContent>
                        </Card>
                        <Card>
                            <CardHeader className="pb-2"><CardDescription>Excedente</CardDescription></CardHeader>
                            <CardContent>
                                <div className="text-2xl font-bold">{consumo?.excedente ?? 0}</div>
                                <p className="text-xs text-muted-foreground">se cobra como paquete</p>
                            </CardContent>
                        </Card>
                        <Card>
                            <CardHeader className="pb-2"><CardDescription>Sin resolver</CardDescription></CardHeader>
                            <CardContent>
                                <div className="text-2xl font-bold">{pendientesBandeja}</div>
                                <p className="text-xs text-muted-foreground">
                                    {resumenBandeja ? 'comprobantes requieren tu acción' : 'comprobantes en la bandeja'}
                                </p>
                            </CardContent>
                        </Card>
                    </div>

                    {eventos.length > 0 && (
                        <Card>
                            <CardHeader>
                                <CardTitle className="text-base">Avisos de Meta</CardTitle>
                                <CardDescription>Cambios en tus plantillas, en la calidad del número o en los límites de envío.</CardDescription>
                            </CardHeader>
                            <CardContent className="space-y-2">
                                {eventos.slice(0, 8).map((e) => (
                                    <div key={e.id} className="text-sm flex items-start gap-2 border-b pb-2 last:border-0">
                                        <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
                                        <div>
                                            <span className="font-medium">{e.template_name ?? e.field}</span>
                                            {e.estado_previo && e.nuevo_estado && (
                                                <span className="text-muted-foreground"> — de {e.estado_previo} a {e.nuevo_estado}</span>
                                            )}
                                            {!e.estado_previo && e.nuevo_estado && (
                                                <span className="text-muted-foreground"> — {e.nuevo_estado}</span>
                                            )}
                                            {e.motivo && <span className="text-muted-foreground"> ({e.motivo})</span>}
                                            <div className="text-xs text-muted-foreground">
                                                {new Date(e.created_at).toLocaleString('es-CO')}
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </CardContent>
                        </Card>
                    )}
                </TabsContent>

                {/* ── Métricas: si el asistente resuelve o solo reparte trabajo ── */}
                <TabsContent value="metricas">
                    {schoolId && <Metricas schoolId={schoolId} />}
                </TabsContent>

                {/* ── Plantillas ── */}
                <TabsContent value="conversaciones">
                    <Conversaciones schoolId={schoolId!} conversacionInicial={conversacionAbrir} />
                </TabsContent>

                {/* ── Clases de cortesía: dónde quedó agendado cada prospecto ── */}
                <TabsContent value="cortesias">
                    {schoolId && <ClasesCortesia schoolId={schoolId} />}
                </TabsContent>

                <TabsContent value="plantillas">
                    <PanelPlantillas
                        schoolId={schoolId!}
                        plantillas={plantillas}
                        cargando={cargandoPlantillas}
                        onCreada={() => void cargarPlantillas()}
                    />
                </TabsContent>

                {/* ── Campañas: un mensaje a quienes preguntaron por clases (plan B5) ── */}
                <TabsContent value="campanas">
                    {schoolId && <Campanas schoolId={schoolId} />}
                </TabsContent>

                {/* ── Bandeja ── */}
                <TabsContent value="bandeja" className="space-y-3">
                    {/* Comprobantes viejos que solo están en el celular de la escuela. */}
                    {schoolId && (
                        <div className="flex justify-end">
                            <ImportarChatExportado schoolId={schoolId} alTerminar={() => {
                                setVersionBandeja((v) => v + 1);
                                void cargar();
                            }} />
                        </div>
                    )}
                    {schoolId && (
                        <BandejaComprobantes
                            key={versionBandeja}
                            schoolId={schoolId}
                            onVerChat={verChat}
                            onCambio={setResumenBandeja}
                        />
                    )}
                </TabsContent>

                {/* ── Configuración ── */}
                <TabsContent value="horarios" className="space-y-4">
                    {schoolId && <HorariosDeEntrenamiento schoolId={schoolId} />}
                </TabsContent>
                <TabsContent value="config" className="space-y-4">
                    <PanelConfig
                        ajustes={estado?.ajustes ?? null}
                        guardando={guardando}
                        onGuardar={guardarAjustes}
                    />
                    {schoolId && <AjusteAudiosSinConsentimiento schoolId={schoolId} />}
                    {schoolId && <AvisosSportMaps schoolId={schoolId} />}
                </TabsContent>
            </Tabs>
        </div>
    );
}

// ─── Plantillas ─────────────────────────────────────────────────────────────

function PanelPlantillas({ schoolId, plantillas, cargando, onCreada }: {
    schoolId: string; plantillas: Plantilla[]; cargando: boolean; onCreada: () => void;
}) {
    const { toast } = useToast();
    const [abriendo, setAbriendo] = useState(false);
    const [enviando, setEnviando] = useState(false);
    const [nombre, setNombre] = useState('');
    const [texto, setTexto] = useState('');
    const [ejemplos, setEjemplos] = useState('');
    // Promoción (campañas, plan B5): va como MARKETING con pie y los tres
    // botones que la campaña sabe atender (la baja siempre de tercera).
    const [promocion, setPromocion] = useState(false);
    const [pie, setPie] = useState('Puedes dejar de recibir promociones cuando quieras');
    const [botones, setBotones] = useState(['Sí, cuéntame', 'Más adelante', 'No recibir más']);

    // Las variables se detectan en vivo: así el usuario sabe cuántos ejemplos
    // debe dar antes de que Meta lo rechace.
    const variables = useMemo(
        () => [...new Set(Array.from(texto.matchAll(/\{\{(\d+)\}\}/g)).map((m) => m[1]))].length,
        [texto],
    );
    const listaEjemplos = ejemplos.split('|').map((s) => s.trim()).filter(Boolean);

    // Catálogo de SportMaps: las plantillas que el sistema sabe mandar
    // (bff/whatsapp-templates). Las que todavía no están en la cuenta de Meta de
    // la escuela se registran desde aquí tal cual (texto, ejemplos y botón).
    const [catalogo, setCatalogo] = useState<PlantillaCatalogo[]>([]);
    const [registrando, setRegistrando] = useState<string | null>(null);
    useEffect(() => {
        let vivo = true;
        bffClient.get<{ catalogo: PlantillaCatalogo[] }>(`/api/v1/whatsapp/${schoolId}/plantillas/catalogo`)
            .then((r) => { if (vivo) setCatalogo(r.catalogo ?? []); })
            .catch(() => { /* BFF anterior: sin catálogo, la pestaña sigue igual */ });
        return () => { vivo = false; };
    }, [schoolId]);
    const enMeta = new Set(plantillas.map((p) => p.name));
    const faltantes = cargando ? [] : catalogo.filter((c) => !enMeta.has(c.name));

    const registrarDelCatalogo = async (nombrePlantilla: string) => {
        setRegistrando(nombrePlantilla);
        try {
            const r = await bffClient.post<{ name: string; status: string; category: string }>(
                `/api/v1/whatsapp/${schoolId}/plantillas/catalogo/${nombrePlantilla}`, {});
            toast({ title: 'Plantilla enviada a Meta', description: `${r.name} — ${r.status} · ${r.category}` });
            onCreada();
        } catch (err: any) {
            toast({ title: 'Meta no la aceptó', description: err?.message ?? 'Error', variant: 'destructive' });
        } finally {
            setRegistrando(null);
        }
    };

    const crear = async () => {
        setEnviando(true);
        try {
            const r = await bffClient.post<{ name: string; status: string; category: string }>(
                `/api/v1/whatsapp/${schoolId}/plantillas`,
                promocion
                    ? {
                        name: nombre, body: texto, ejemplos: listaEjemplos, category: 'MARKETING', language: 'es_CO',
                        pie: pie.trim(), botones_rapidos: botones.map((b) => b.trim()),
                    }
                    : { name: nombre, body: texto, ejemplos: listaEjemplos, category: 'UTILITY', language: 'es_CO' },
            );
            toast({
                title: 'Plantilla enviada a Meta',
                description: `${r.name} — ${r.status} · ${r.category}`,
            });
            setAbriendo(false); setNombre(''); setTexto(''); setEjemplos(''); setPromocion(false);
            onCreada();
        } catch (err: any) {
            toast({ title: 'Meta no la aceptó', description: err?.message ?? 'Error', variant: 'destructive' });
        } finally {
            setEnviando(false);
        }
    };

    return (
        <Card>
            <CardHeader className="flex-row items-start justify-between space-y-0">
                <div>
                    <CardTitle className="text-base">Plantillas aprobadas por Meta</CardTitle>
                    <CardDescription>
                        Son los mensajes que la escuela puede enviar <strong>fuera</strong> de la ventana de 24 horas
                        — la cobranza, sobre todo. Si Meta desactiva o recategoriza una, deja de enviarse.
                    </CardDescription>
                </div>
                <Button onClick={() => setAbriendo((v) => !v)}>
                    <Plus className="h-4 w-4 mr-1" /> Nueva plantilla
                </Button>
            </CardHeader>
            <CardContent className="space-y-4">
                {abriendo && (
                    <div className="border rounded-lg p-4 space-y-3 bg-muted/30">
                        <div>
                            <Label>Nombre</Label>
                            <Input value={nombre} onChange={(e) => setNombre(e.target.value)}
                                placeholder="clase_cancelada" />
                            <p className="text-xs text-muted-foreground mt-1">
                                Solo minúsculas, números y guion bajo.
                            </p>
                        </div>
                        <div>
                            <Label>Texto del mensaje</Label>
                            <Textarea rows={3} value={texto} onChange={(e) => setTexto(e.target.value)}
                                placeholder="Hola {{1}}, la clase de {{2}} del {{3}} fue cancelada." />
                            <p className="text-xs text-muted-foreground mt-1">
                                Usa {'{{1}}'}, {'{{2}}'}… para los datos variables. No puede empezar ni terminar
                                con una variable — Meta lo rechaza.
                            </p>
                        </div>
                        {variables > 0 && (
                            <div>
                                <Label>Ejemplos para las {variables} variable(s), separados por |</Label>
                                <Input value={ejemplos} onChange={(e) => setEjemplos(e.target.value)}
                                    placeholder="Carolina | Samuel | 13 de septiembre" />
                                <p className="text-xs text-muted-foreground mt-1">
                                    Van {listaEjemplos.length} de {variables}. Meta los exige para revisar la plantilla.
                                </p>
                            </div>
                        )}
                        <div className="flex items-start gap-2">
                            <Switch id="plantilla-promocion" checked={promocion} onCheckedChange={setPromocion} />
                            <div>
                                <Label htmlFor="plantilla-promocion">Es una promoción (para Campañas)</Label>
                                <p className="text-xs text-muted-foreground">
                                    Meta la cobra como marketing. Lleva un pie y tres botones: el tercero siempre es para no
                                    recibir más.
                                </p>
                            </div>
                        </div>
                        {promocion && (
                            <div className="space-y-2">
                                <div>
                                    <Label>Pie del mensaje</Label>
                                    <Input value={pie} maxLength={60} onChange={(e) => setPie(e.target.value)} />
                                </div>
                                <div className="grid gap-2 sm:grid-cols-3">
                                    {botones.map((b, i) => (
                                        <div key={i}>
                                            <Label>Botón {i + 1}</Label>
                                            <Input value={b} maxLength={25} disabled={i === 2}
                                                onChange={(e) => setBotones(botones.map((x, j) => (j === i ? e.target.value : x)))} />
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}
                        <Button onClick={() => void crear()}
                            disabled={enviando || !nombre || texto.length < 10 || listaEjemplos.length !== variables
                                || (promocion && (!pie.trim() || botones.some((b) => !b.trim())))}>
                            {enviando && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                            Enviar a Meta para aprobación
                        </Button>
                    </div>
                )}

                {faltantes.length > 0 && (
                    <div className="border rounded-lg p-4 space-y-3 border-amber-200 bg-amber-50/50">
                        <div>
                            <p className="text-sm font-medium">Plantillas de SportMaps que faltan en tu cuenta</p>
                            <p className="text-xs text-muted-foreground">
                                El sistema las usa para avisos fuera de la ventana de 24 horas. Meta tarda de minutos a
                                un par de días en aprobarlas; mientras tanto esos avisos no salen por WhatsApp.
                            </p>
                        </div>
                        {faltantes.map((c) => (
                            <div key={c.name} className="flex items-start justify-between gap-3 border-t pt-3 first:border-t-0 first:pt-0">
                                <div className="min-w-0">
                                    <p className="font-mono text-sm">{c.name}</p>
                                    <p className="text-xs text-muted-foreground whitespace-pre-wrap break-words">{c.texto}</p>
                                    {c.boton && <p className="text-xs text-muted-foreground">Botón: {c.boton}</p>}
                                </div>
                                <Button size="sm" variant="outline" disabled={registrando !== null}
                                    onClick={() => void registrarDelCatalogo(c.name)}>
                                    {registrando === c.name && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                                    Enviar a Meta
                                </Button>
                            </div>
                        ))}
                    </div>
                )}

                {cargando ? (
                    <p className="text-sm text-muted-foreground py-6 text-center">Consultando a Meta…</p>
                ) : plantillas.length === 0 ? (
                    <p className="text-sm text-muted-foreground py-6 text-center">Todavía no hay plantillas.</p>
                ) : (
                    <div className="space-y-1">
                        {plantillas.map((p) => (
                            <div key={`${p.name}-${p.language}`}
                                className="flex items-center justify-between border-b py-2 last:border-0 text-sm">
                                <span className="font-mono">{p.name}</span>
                                <div className="flex items-center gap-2">
                                    <Badge variant="outline">{p.category}</Badge>
                                    <Badge className={tonoDeEstado(p.status)}>{p.status}</Badge>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </CardContent>
        </Card>
    );
}

// ─── Configuración ──────────────────────────────────────────────────────────

/**
 * Ajuste por escuela `school_settings.wa_transcribir_sin_consentimiento`
 * (mig. 20261006232151). Se guarda directo en `school_settings` con la RLS
 * de admin de la escuela, como los demás ajustes wa_* del asistente. Si la
 * columna todavía no existe en la base, el interruptor queda deshabilitado.
 */
function AjusteAudiosSinConsentimiento({ schoolId }: { schoolId: string }) {
    const { toast } = useToast();
    const [valor, setValor] = useState<boolean | null>(null);
    const [disponible, setDisponible] = useState(true);
    const [guardando, setGuardando] = useState(false);

    useEffect(() => {
        let vivo = true;
        (async () => {
            const { data, error } = await (supabase as any)
                .from('school_settings')
                .select('wa_transcribir_sin_consentimiento')
                .eq('school_id', schoolId)
                .maybeSingle();
            if (!vivo) return;
            if (error) { setDisponible(false); setValor(false); return; }
            setValor(data?.wa_transcribir_sin_consentimiento === true);
        })();
        return () => { vivo = false; };
    }, [schoolId]);

    const cambiar = async (v: boolean) => {
        setGuardando(true);
        const { error } = await (supabase as any)
            .from('school_settings')
            .upsert({ school_id: schoolId, wa_transcribir_sin_consentimiento: v }, { onConflict: 'school_id' });
        setGuardando(false);
        if (error) {
            toast({ title: 'No se pudo guardar', description: error.message, variant: 'destructive' });
            return;
        }
        setValor(v);
        toast({ title: v ? 'Notas de voz activadas' : 'Notas de voz desactivadas' });
    };

    return (
        <Card>
            <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                    <MessageSquare className="h-4 w-4" /> Notas de voz
                </CardTitle>
            </CardHeader>
            <CardContent>
                <div className="flex items-start justify-between gap-4">
                    <div>
                        <Label htmlFor="wa-audios-sin-consentimiento">
                            Escuchar las notas de voz de familias e interesados
                        </Label>
                        <p className="text-sm text-muted-foreground">
                            Mapi pasa a texto los audios que le mandan las familias y quienes preguntan
                            por inscripciones, aunque no hayan aceptado los avisos por WhatsApp. Nunca los de tus
                            contactos personales ni los del equipo. El audio no se guarda, y en su primera
                            respuesta Mapi le avisa a la persona que convierte sus audios en texto.
                            Apagado, solo escucha a las familias que aceptaron los avisos.
                        </p>
                        {!disponible && (
                            <p className="text-xs text-muted-foreground mt-1">
                                Disponible cuando se active en la plataforma.
                            </p>
                        )}
                    </div>
                    <Switch
                        id="wa-audios-sin-consentimiento"
                        className="shrink-0"
                        checked={valor === true}
                        disabled={guardando || valor === null || !disponible}
                        onCheckedChange={(v) => void cambiar(v)}
                    />
                </div>
            </CardContent>
        </Card>
    );
}

function PanelConfig({ ajustes, guardando, onGuardar }: {
    ajustes: Ajustes | null; guardando: boolean; onGuardar: (c: Partial<Ajustes>) => void;
}) {
    const [dias, setDias] = useState<Record<string, [string, string]>>(ajustes?.business_hours?.dias ?? {});

    useEffect(() => { setDias(ajustes?.business_hours?.dias ?? {}); }, [ajustes]);

    const alternarDia = (d: string) => {
        setDias((prev) => {
            const copia = { ...prev };
            if (copia[d]) delete copia[d];
            else copia[d] = ['08:00', '17:00'];
            return copia;
        });
    };

    return (
        <div className="space-y-4">
            <Card>
                <CardHeader>
                    <CardTitle className="text-base">Cómo responde el bot</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="flex items-start justify-between gap-4">
                        <div>
                            <Label>Responder automáticamente</Label>
                            <p className="text-sm text-muted-foreground">
                                Si lo apagas, el bot prepara las respuestas pero alguien de la escuela
                                tiene que aprobarlas antes de que salgan.
                            </p>
                        </div>
                        <Switch
                            className="shrink-0"
                            checked={ajustes?.mode === 'auto'}
                            disabled={guardando}
                            onCheckedChange={(v) => onGuardar({ mode: v ? 'auto' : 'assisted' })}
                        />
                    </div>
                    <div className="flex items-start justify-between gap-4">
                        <div>
                            <Label htmlFor="wa-ai-enabled">Mapi encendida</Label>
                            <p className="text-sm text-muted-foreground">
                                Apagada, Mapi <strong>no responde nada automático</strong>: ningún
                                mensaje recibe respuesta del bot y todo lo contesta una persona. Solo siguen
                                saliendo los avisos automáticos de pagos.
                            </p>
                        </div>
                        <Switch
                            id="wa-ai-enabled"
                            className="shrink-0"
                            checked={ajustes?.ai_enabled !== false}
                            disabled={guardando}
                            onCheckedChange={(v) => onGuardar({ ai_enabled: v })}
                        />
                    </div>
                    <div className="flex items-start justify-between gap-4">
                        <div>
                            <Label htmlFor="wa-responder-desconocidos">
                                Responder también a números que no son familias
                            </Label>
                            <p className="text-sm text-muted-foreground">
                                Si está apagado, Mapi solo contesta a acudientes de la escuela. Los
                                demás mensajes los sigues viendo y respondiendo desde tu celular.
                            </p>
                        </div>
                        <Switch
                            id="wa-responder-desconocidos"
                            className="shrink-0"
                            checked={ajustes?.responder_desconocidos === true}
                            disabled={guardando || ajustes?.ai_enabled === false}
                            onCheckedChange={(v) => onGuardar({ responder_desconocidos: v })}
                        />
                    </div>
                    <div className="flex items-start justify-between gap-4">
                        <div>
                            <Label htmlFor="wa-responder-prospectos">
                                Responder a quienes piden información para inscribirse
                            </Label>
                            <p className="text-sm text-muted-foreground">
                                Aunque lo de arriba esté apagado, Mapi contesta a números nuevos que
                                escriben claramente por inscripciones, horarios, precios o la clase de cortesía, y
                                los deja registrados como prospectos. A los saludos sueltos y a tus contactos
                                personales no les escribe.
                            </p>
                        </div>
                        <Switch
                            id="wa-responder-prospectos"
                            className="shrink-0"
                            checked={ajustes?.responder_prospectos !== false}
                            disabled={guardando || ajustes?.ai_enabled === false || ajustes?.responder_desconocidos === true}
                            onCheckedChange={(v) => onGuardar({ responder_prospectos: v })}
                        />
                    </div>
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle className="text-base flex items-center gap-2">
                        <Clock className="h-4 w-4" /> Horario de atención
                    </CardTitle>
                    <CardDescription>
                        El bot responde siempre, a cualquier hora. Esto cambia lo que <strong>promete</strong>:
                        fuera del horario, cuando pasa un caso a una persona, le dice al acudiente cuándo
                        le responden de verdad en vez de «en breve te contactan».
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                    {DIAS.map(([num, nombre]) => (
                        <div key={num} className="flex items-center gap-3">
                            <Switch checked={!!dias[num]} onCheckedChange={() => alternarDia(num)} />
                            <span className="w-24 text-sm">{nombre}</span>
                            {dias[num] && (
                                <>
                                    <Input type="time" className="w-28" value={dias[num][0]}
                                        onChange={(e) => setDias((p) => ({ ...p, [num]: [e.target.value, p[num][1]] }))} />
                                    <span className="text-muted-foreground text-sm">a</span>
                                    <Input type="time" className="w-28" value={dias[num][1]}
                                        onChange={(e) => setDias((p) => ({ ...p, [num]: [p[num][0], e.target.value] }))} />
                                </>
                            )}
                        </div>
                    ))}
                    <div className="flex gap-2 pt-2">
                        <Button disabled={guardando}
                            onClick={() => onGuardar({
                                business_hours: Object.keys(dias).length
                                    ? { tz: 'America/Bogota', dias }
                                    : null,
                            })}>
                            {guardando && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                            Guardar horario
                        </Button>
                        {Object.keys(dias).length === 0 && (
                            <p className="text-sm text-muted-foreground self-center">
                                Sin horario configurado no se promete una hora concreta.
                            </p>
                        )}
                    </div>
                </CardContent>
            </Card>
        </div>
    );
}
