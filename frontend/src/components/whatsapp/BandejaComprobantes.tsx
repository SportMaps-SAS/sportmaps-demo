/**
 * BandejaComprobantes — los comprobantes que llegaron por WhatsApp y el bot no
 * pudo aplicar solo.
 *
 * Hasta el 2026-10-07 era una lista plana (teléfono · tipo · código interno)
 * con un contador que sumaba de todo: fotos personales, capturas de correos y
 * pagos que la escuela ya había registrado. En Dynasty marcaba «100» (el tope
 * del listado) cuando lo que pedía una decisión eran ~25. Ahora:
 *
 *  · Tres secciones: «Requiere tu acción», «Para revisar» e «Informativo»
 *    (cerrada por defecto). El grupo lo decide el BFF (whatsapp-bandeja.service).
 *  · Miniatura del comprobante y «Ver chat», para decidir sin ir al celular.
 *  · «Marcar resuelto» y «Descartar», con motivo. No tocan pagos: si había que
 *    aplicar el comprobante, se aplica en Pagos y aquí se marca resuelto.
 *  · Lo que ya estaba registrado se cierra solo al abrir la bandeja.
 *
 * 2026-10-13 (Dynasty: 206 abiertas, 0 cerradas por la escuela). El cierre
 * funcionaba, pero era de a una y con motivo escrito, sobre una lista donde la
 * mayoría eran fotos de contactos que no son familias. Ahora:
 *  · «Descartar las N» / «Marcar las N resueltas» por sección, con un solo
 *    motivo (POST /bandeja/cerrar-lote).
 *  · Se cierran solas también las que la escuela ya aprobó o rechazó en Pagos
 *    (cualquier camino), no solo las «ya registradas».
 *  · Conteos arriba: cuántas quedan por grupo y cuántas se cerraron en 30 días.
 *
 * 2026-10-13, tarde (Dynasty: 37 fotos de un proveedor, 14 del círculo de la
 * dueña). Los números que no son familias se marcan UNA vez:
 *  · «Tipo de contacto» desde cada tarjeta (Personal / Negocio / Otro club /
 *    Plataforma, + «También es familia»). Marcar cierra sus filas abiertas y
 *    las que lleguen después ya no entran (lo hace el BFF).
 *  · Sugerencias arriba: números que nunca estuvieron en una ficha y mandaron
 *    más de 5 adjuntos en 24 h, o cuyo nombre suena a negocio. Solo sugiere:
 *    marcar siempre lo confirma la escuela.
 *  · Ráfagas: las filas del mismo número, día y motivo van en UNA tarjeta con
 *    contador y acciones en lote (bandejaRafagas.ts). Los datos no cambian.
 */

import { useCallback, useEffect, useState } from 'react';
import { bffClient } from '@/lib/api/bffClient';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
    Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { CheckCircle2, ChevronDown, FileText, Loader2, MessageSquare, RefreshCw, Tags, X, XCircle } from 'lucide-react';
import { TipoDeContactoDialog } from './TipoDeContactoDialog';
import { esMarcaNoFamilia, TEXTO_DE_MARCA, type MarcaDeContacto, type OpcionDeTipo } from './tipoDeContacto';
import { agruparRafagas, textoDeRafaga } from './bandejaRafagas';

type Grupo = 'accion' | 'revisar' | 'informativo';

export interface FilaDeBandeja {
    id: string;
    status: string;
    wa_phone_number: string;
    message_type: string;
    media_mime_type: string | null;
    media_caption: string | null;
    error_message: string | null;
    created_at: string;
    grupo: Grupo;
    motivo: string;
    etiqueta: string;
    detalle: string | null;
    conversacion_id: string | null;
    contacto: string | null;
    archivo_url: string | null;
    /** `contact_kind` de la conversación (familia, desconocido, personal…). Ausente en backends viejos. */
    tipo_contacto?: string | null;
    tambien_familia?: boolean;
}

/** «¿Marcar como negocio?»: número sin ficha con ráfaga de adjuntos o nombre de negocio. */
export interface SugerenciaDeMarca {
    wa_phone_number: string;
    conversacion_id: string | null;
    contacto: string | null;
    motivo: 'rafaga' | 'nombre';
    adjuntos_24h: number;
    filas: number;
    tipo_sugerido: MarcaDeContacto;
}
export interface ResumenBandeja { accion: number; revisar: number; informativo: number; total: number }
export interface CierresRecientes { escuela: number; automaticas: number; total: number }

const SECCIONES: { grupo: Grupo; titulo: string; ayuda: string }[] = [
    { grupo: 'accion', titulo: 'Requiere tu acción',
      ayuda: 'Hay plata de por medio y Mapi no supo a qué cobro va. Aplícalo en Pagos y márcalo resuelto.' },
    { grupo: 'revisar', titulo: 'Para revisar',
      ayuda: 'Puede ser un pago, pero lo normal es que no: números que no son familias, familias sin cobros pendientes.' },
    { grupo: 'informativo', titulo: 'Informativo (no requiere nada)',
      ayuda: 'No eran comprobantes, ya estaban registrados o llegaron de contactos personales.' },
];

const MOTIVOS_RAPIDOS: Record<'resuelto' | 'descartado', string[]> = {
    resuelto: ['Lo registré en Pagos', 'Ya estaba pagado', 'Lo resolví con la familia'],
    descartado: ['No es un pago de la escuela', 'Contacto personal', 'No es un comprobante', 'Duplicado'],
};

const PARECE_DE: Record<MarcaDeContacto, string> = {
    negocio: 'un negocio', otro_club: 'otro club', plataforma: 'una plataforma', personal: 'un contacto personal', equipo: 'alguien del staff',
};

function enmascarar(tel: string): string {
    return tel ? `···${tel.slice(-4)}` : '';
}

export function BandejaComprobantes({ schoolId, onVerChat, onCambio }: {
    schoolId: string;
    /** Abre la conversación en la pestaña Conversaciones. */
    onVerChat: (conversacionId: string) => void;
    /** Avisa que cambió el contador (para refrescar la pestaña). */
    onCambio?: (resumen: ResumenBandeja) => void;
}) {
    const { toast } = useToast();
    const [filas, setFilas] = useState<FilaDeBandeja[]>([]);
    const [resumen, setResumen] = useState<ResumenBandeja | null>(null);
    const [cargando, setCargando] = useState(true);
    // Cierre de una fila o de una sección entera (lote).
    const [cierre, setCierre] = useState<{ filas: FilaDeBandeja[]; accion: 'resuelto' | 'descartado'; lote: boolean } | null>(null);
    const [cierres, setCierres] = useState<CierresRecientes | null>(null);
    const [motivo, setMotivo] = useState('');
    const [guardando, setGuardando] = useState(false);
    const [sugerencias, setSugerencias] = useState<SugerenciaDeMarca[]>([]);
    // «Ahora no» de una sugerencia: solo en esta pantalla, no se guarda.
    const [ocultas, setOcultas] = useState<Set<string>>(new Set());
    const [rafagasAbiertas, setRafagasAbiertas] = useState<Set<string>>(new Set());
    const [marcar, setMarcar] = useState<{
        conversacionId: string; nombre: string | null; tipo: OpcionDeTipo; tambienFamilia: boolean;
    } | null>(null);

    const cargar = useCallback(async () => {
        setCargando(true);
        try {
            const r = await bffClient.get<{
                filas: FilaDeBandeja[]; resumen: ResumenBandeja; cerradas_solas: number; cierres_30d?: CierresRecientes | null;
                sugerencias_marca?: SugerenciaDeMarca[];
            }>(`/api/v1/whatsapp/${schoolId}/bandeja`);
            setFilas(r.filas ?? []);
            setSugerencias(r.sugerencias_marca ?? []);
            setResumen(r.resumen ?? null);
            setCierres(r.cierres_30d ?? null);
            if (r.resumen) onCambio?.(r.resumen);
            if ((r.cerradas_solas ?? 0) > 0) {
                toast({ title: `${r.cerradas_solas} se cerraron solas`, description: 'Ya estaban registradas, aprobadas o rechazadas en Pagos.' });
            }
        } catch (e: any) {
            toast({ title: 'No se pudo cargar la bandeja', description: e?.message, variant: 'destructive' });
        } finally {
            setCargando(false);
        }
    // onCambio cambia en cada render del padre: no debe disparar recargas.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [schoolId, toast]);

    useEffect(() => { void cargar(); }, [cargar]);

    const abrirCierre = (fila: FilaDeBandeja, accion: 'resuelto' | 'descartado') => {
        setCierre({ filas: [fila], accion, lote: false });
        setMotivo('');
    };
    const abrirCierreLote = (deEsta: FilaDeBandeja[], accion: 'resuelto' | 'descartado') => {
        setCierre({ filas: deEsta, accion, lote: true });
        setMotivo('');
    };

    const confirmarCierre = async () => {
        if (!cierre || motivo.trim().length < 3) return;
        setGuardando(true);
        try {
            let cerradas: Set<string>;
            if (cierre.lote) {
                // De a 300 (el tope del BFF por llamada).
                cerradas = new Set();
                for (let i = 0; i < cierre.filas.length; i += 300) {
                    const r = await bffClient.post<{ cerradas: string[] }>(`/api/v1/whatsapp/${schoolId}/bandeja/cerrar-lote`,
                        { ids: cierre.filas.slice(i, i + 300).map((f) => f.id), accion: cierre.accion, motivo: motivo.trim() });
                    for (const id of r.cerradas ?? []) cerradas.add(id);
                }
            } else {
                await bffClient.post(`/api/v1/whatsapp/${schoolId}/bandeja/${cierre.filas[0].id}/cerrar`,
                    { accion: cierre.accion, motivo: motivo.trim() });
                cerradas = new Set([cierre.filas[0].id]);
            }
            const restantes = filas.filter((f) => !cerradas.has(f.id));
            setFilas(restantes);
            const nuevo: ResumenBandeja = {
                accion: restantes.filter((f) => f.grupo === 'accion').length,
                revisar: restantes.filter((f) => f.grupo === 'revisar').length,
                informativo: restantes.filter((f) => f.grupo === 'informativo').length,
                total: restantes.length,
            };
            setResumen(nuevo);
            onCambio?.(nuevo);
            setCierres((c) => (c ? { ...c, escuela: c.escuela + cerradas.size, total: c.total + cerradas.size } : c));
            toast({ title: cierre.lote
                ? `${cerradas.size} ${cerradas.size === 1 ? 'cerrada' : 'cerradas'}`
                : cierre.accion === 'resuelto' ? 'Marcado como resuelto' : 'Descartado' });
            setCierre(null);
        } catch (e: any) {
            toast({ title: 'No se pudo guardar', description: e?.message, variant: 'destructive' });
        } finally {
            setGuardando(false);
        }
    };

    /** Abre «Tipo de contacto» para el número de una tarjeta (o de una sugerencia). */
    const abrirMarcar = (conversacionId: string | null, nombre: string | null, tipo: OpcionDeTipo, tambienFamilia = false) => {
        if (!conversacionId) return;
        setMarcar({ conversacionId, nombre, tipo, tambienFamilia });
    };
    const marcarDesdeFila = (f: FilaDeBandeja) => abrirMarcar(f.conversacion_id, f.contacto || enmascarar(f.wa_phone_number),
        esMarcaNoFamilia(f.tipo_contacto) ? f.tipo_contacto : 'personal', f.tambien_familia === true);

    const botonMarcar = (f: FilaDeBandeja) => f.conversacion_id && (
        <Button size="sm" variant="ghost" onClick={() => marcarDesdeFila(f)} title="Familia, personal, negocio, otro club…">
            <Tags className="h-3.5 w-3.5 mr-1" /> Tipo de contacto
        </Button>
    );

    const miniatura = (f: FilaDeBandeja, tam: 'normal' | 'chica' = 'normal') => {
        const esImagen = (f.media_mime_type ?? '').startsWith('image/') || f.message_type === 'image';
        const lado = tam === 'chica' ? 'w-12 h-12' : 'w-16 h-16';
        return (
            <div key={f.id} className={`shrink-0 ${lado} rounded-md border bg-muted/40 overflow-hidden flex items-center justify-center`}>
                {f.archivo_url && esImagen ? (
                    <a href={f.archivo_url} target="_blank" rel="noreferrer" title="Abrir el comprobante">
                        <img src={f.archivo_url} alt="Comprobante" loading="lazy" className={`${lado} object-cover`} />
                    </a>
                ) : f.archivo_url ? (
                    <a href={f.archivo_url} target="_blank" rel="noreferrer" className="flex flex-col items-center text-xs text-primary">
                        <FileText className="h-5 w-5" /> PDF
                    </a>
                ) : (
                    <span className="text-xs text-muted-foreground text-center px-1">Sin archivo</span>
                )}
            </div>
        );
    };

    /** Una tarjeta por ráfaga: mismo número, mismo día, mismo motivo. */
    const rafaga = (clave: string, deEsta: FilaDeBandeja[]) => {
        const f = deEsta[0];
        const abierta = rafagasAbiertas.has(clave);
        const alternar = () => setRafagasAbiertas((s) => {
            const n = new Set(s);
            if (n.has(clave)) n.delete(clave); else n.add(clave);
            return n;
        });
        const accionLote: 'resuelto' | 'descartado' = f.grupo === 'accion' ? 'resuelto' : 'descartado';
        return (
            <div key={clave} className="border-b py-3 last:border-0 text-sm space-y-2" data-testid="rafaga">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="font-medium truncate">{f.contacto || enmascarar(f.wa_phone_number)}</span>
                    {f.contacto && <span className="text-xs text-muted-foreground">{enmascarar(f.wa_phone_number)}</span>}
                    <span className="text-xs text-muted-foreground">
                        {new Date(f.created_at).toLocaleDateString('es-CO', { dateStyle: 'medium' })}
                    </span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="secondary">{textoDeRafaga(deEsta)}</Badge>
                    <Badge variant="outline" className="font-normal">{f.etiqueta}</Badge>
                </div>
                <div className="flex gap-2 overflow-x-auto scrollbar-none">
                    {deEsta.slice(0, 6).map((x) => miniatura(x, 'chica'))}
                </div>
                <div className="flex flex-wrap gap-2 [&>button]:min-h-touch md:[&>button]:min-h-0">
                    {f.conversacion_id && (
                        <Button size="sm" variant="outline" onClick={() => onVerChat(f.conversacion_id!)}>
                            <MessageSquare className="h-3.5 w-3.5 mr-1" /> Ver chat
                        </Button>
                    )}
                    <Button size="sm" variant="outline" onClick={() => abrirCierreLote(deEsta, accionLote)}>
                        {accionLote === 'resuelto'
                            ? <><CheckCircle2 className="h-3.5 w-3.5 mr-1" /> Marcar estas {deEsta.length} resueltas</>
                            : <><XCircle className="h-3.5 w-3.5 mr-1" /> Descartar estas {deEsta.length}</>}
                    </Button>
                    {botonMarcar(f)}
                    <Button size="sm" variant="ghost" onClick={alternar} aria-expanded={abierta}>
                        <ChevronDown className={`h-3.5 w-3.5 mr-1 transition-transform ${abierta ? 'rotate-180' : ''}`} />
                        {abierta ? 'Ocultar' : 'Ver una por una'}
                    </Button>
                </div>
                {abierta && <div className="border-l pl-3">{deEsta.map(fila)}</div>}
            </div>
        );
    };

    /** Las filas de una sección, con las ráfagas juntas. */
    const listar = (deEsta: FilaDeBandeja[]) => agruparRafagas(deEsta).map((b) =>
        b.tipo === 'rafaga' ? rafaga(b.clave, b.filas) : fila(b.fila));

    const sugerenciasVisibles = sugerencias.filter((s) => s.conversacion_id && !ocultas.has(s.wa_phone_number));

    const fila = (f: FilaDeBandeja) => {
        return (
            <div key={f.id} className="flex gap-3 border-b py-3 last:border-0 text-sm">
                {miniatura(f)}
                <div className="flex-1 min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="font-medium truncate">{f.contacto || enmascarar(f.wa_phone_number)}</span>
                        {f.contacto && <span className="text-xs text-muted-foreground">{enmascarar(f.wa_phone_number)}</span>}
                        <span className="text-xs text-muted-foreground">
                            {new Date(f.created_at).toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' })}
                        </span>
                    </div>
                    <Badge variant="outline" className="font-normal">{f.etiqueta}</Badge>
                    {f.detalle && <p className="text-xs text-muted-foreground line-clamp-2">{f.detalle}</p>}
                    {f.media_caption && <p className="text-xs italic line-clamp-2">«{f.media_caption}»</p>}
                    {!f.archivo_url && f.grupo !== 'informativo' && (
                        <p className="text-xs text-muted-foreground">El archivo no se guardó: míralo en el chat.</p>
                    )}
                    <div className="flex flex-wrap gap-2 pt-1 [&>button]:min-h-touch md:[&>button]:min-h-0">
                        {f.conversacion_id && (
                            <Button size="sm" variant="outline" onClick={() => onVerChat(f.conversacion_id!)}>
                                <MessageSquare className="h-3.5 w-3.5 mr-1" /> Ver chat
                            </Button>
                        )}
                        <Button size="sm" variant="outline" onClick={() => abrirCierre(f, 'resuelto')}>
                            <CheckCircle2 className="h-3.5 w-3.5 mr-1" /> Marcar resuelto
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => abrirCierre(f, 'descartado')}>
                            <XCircle className="h-3.5 w-3.5 mr-1" /> Descartar
                        </Button>
                        {botonMarcar(f)}
                    </div>
                </div>
            </div>
        );
    };

    return (
        <Card>
            <CardHeader>
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <CardTitle className="text-base">Comprobantes sin resolver</CardTitle>
                    <Button size="sm" variant="outline" onClick={() => void cargar()} disabled={cargando}>
                        <RefreshCw className={`h-4 w-4 mr-1 ${cargando ? 'animate-spin' : ''}`} /> Actualizar
                    </Button>
                </div>
                <CardDescription>
                    Lo que llegó por el chat y Mapi no pudo aplicar solo. Marcar resuelto o descartar no
                    cambia ningún pago: si hay que registrarlo, hazlo en Pagos. Lo que se aprueba o rechaza en Pagos
                    sale de aquí solo.
                </CardDescription>
                {resumen && (
                    <div className="flex flex-wrap gap-x-4 gap-y-1 pt-1 text-xs text-muted-foreground" data-testid="conteos-bandeja">
                        <span><strong className="text-foreground">{resumen.accion}</strong> requieren tu acción</span>
                        <span><strong className="text-foreground">{resumen.revisar}</strong> para revisar</span>
                        <span><strong className="text-foreground">{resumen.informativo}</strong> informativas</span>
                        {cierres && (
                            <span>Cerradas en 30 días: <strong className="text-foreground">{cierres.escuela}</strong> por la escuela
                                {' · '}<strong className="text-foreground">{cierres.automaticas}</strong> solas</span>
                        )}
                    </div>
                )}
            </CardHeader>
            <CardContent className="space-y-6">
                {sugerenciasVisibles.length > 0 && (
                    <section className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 space-y-2" data-testid="sugerencias-marca">
                        <h3 className="font-semibold text-sm">¿Estos números no son familias?</h3>
                        <p className="text-xs text-muted-foreground">
                            Nunca han estado en una ficha. Si los marcas, sus fotos dejan de llegar aquí y las que ya
                            están se cierran. Nada se marca solo.
                        </p>
                        {sugerenciasVisibles.map((s) => (
                            <div key={s.wa_phone_number} className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-amber-500/20 pt-2 text-sm">
                                <div className="min-w-0 flex-1">
                                    <p className="font-medium truncate">{s.contacto || enmascarar(s.wa_phone_number)}</p>
                                    <p className="text-xs text-muted-foreground">
                                        {s.motivo === 'rafaga'
                                            ? `${s.adjuntos_24h} archivos en 24 horas`
                                            : `El nombre parece de ${PARECE_DE[s.tipo_sugerido]}`}
                                        {' · '}{s.filas} en la bandeja
                                    </p>
                                </div>
                                <div className="flex flex-wrap gap-2 [&>button]:min-h-touch md:[&>button]:min-h-0">
                                    <Button size="sm" variant="outline"
                                            onClick={() => abrirMarcar(s.conversacion_id, s.contacto || enmascarar(s.wa_phone_number), s.tipo_sugerido)}>
                                        <Tags className="h-3.5 w-3.5 mr-1" /> Marcar como {TEXTO_DE_MARCA[s.tipo_sugerido]}…
                                    </Button>
                                    <Button size="sm" variant="ghost" aria-label={`Ahora no: ${s.contacto || enmascarar(s.wa_phone_number)}`}
                                            onClick={() => setOcultas((o) => new Set(o).add(s.wa_phone_number))}>
                                        <X className="h-3.5 w-3.5 mr-1" /> Ahora no
                                    </Button>
                                </div>
                            </div>
                        ))}
                    </section>
                )}
                {cargando && !resumen ? (
                    <p className="text-sm text-muted-foreground py-8 flex items-center justify-center gap-2">
                        <Loader2 className="h-4 w-4 animate-spin" /> Cargando…
                    </p>
                ) : filas.length === 0 ? (
                    <p className="text-sm text-muted-foreground py-8 text-center">
                        No hay nada pendiente. Todo lo que llegó se resolvió.
                    </p>
                ) : (
                    SECCIONES.map((s) => {
                        const deEsta = filas.filter((f) => f.grupo === s.grupo);
                        if (!deEsta.length) return null;
                        const encabezado = (
                            <div className="flex items-center gap-2">
                                <h3 className="font-semibold text-sm">{s.titulo}</h3>
                                <Badge variant={s.grupo === 'accion' ? 'default' : 'secondary'}>{deEsta.length}</Badge>
                            </div>
                        );
                        // Lo que no pide nada se descarta junto; lo que tiene plata
                        // de por medio se marca resuelto (después de aplicarlo en Pagos).
                        const accionLote: 'resuelto' | 'descartado' = s.grupo === 'accion' ? 'resuelto' : 'descartado';
                        const botonLote = deEsta.length > 1 && (
                            <Button size="sm" variant="outline" className="min-h-touch md:min-h-0"
                                    onClick={() => abrirCierreLote(deEsta, accionLote)}>
                                {accionLote === 'resuelto'
                                    ? <><CheckCircle2 className="h-3.5 w-3.5 mr-1" /> Marcar las {deEsta.length} resueltas</>
                                    : <><XCircle className="h-3.5 w-3.5 mr-1" /> Descartar las {deEsta.length}</>}
                            </Button>
                        );
                        if (s.grupo === 'informativo') {
                            return (
                                <Collapsible key={s.grupo}>
                                    <CollapsibleTrigger className="flex w-full min-h-touch items-center justify-between gap-2 text-left md:min-h-0">
                                        {encabezado}
                                        <ChevronDown className="h-4 w-4 text-muted-foreground" />
                                    </CollapsibleTrigger>
                                    <p className="text-xs text-muted-foreground mt-1">{s.ayuda}</p>
                                    {botonLote && <div className="mt-2">{botonLote}</div>}
                                    <CollapsibleContent>{listar(deEsta)}</CollapsibleContent>
                                </Collapsible>
                            );
                        }
                        return (
                            <section key={s.grupo}>
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                    {encabezado}
                                    {botonLote}
                                </div>
                                <p className="text-xs text-muted-foreground mt-1">{s.ayuda}</p>
                                <div>{listar(deEsta)}</div>
                            </section>
                        );
                    })
                )}
            </CardContent>

            <Dialog open={!!cierre} onOpenChange={(v) => { if (!v) setCierre(null); }}>
                <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-modal">
                    <DialogHeader>
                        <DialogTitle>
                            {cierre?.lote
                                ? `${cierre.accion === 'resuelto' ? 'Marcar resueltos' : 'Descartar'} ${cierre.filas.length} comprobantes`
                                : cierre?.accion === 'resuelto' ? 'Marcar resuelto' : 'Descartar'}
                        </DialogTitle>
                        <DialogDescription>
                            {cierre?.lote ? 'Salen todos de la bandeja con el mismo motivo.' : 'Sale de la bandeja.'} No cambia ningún pago.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-2">
                        <div className="flex flex-wrap gap-2">
                            {cierre && MOTIVOS_RAPIDOS[cierre.accion].map((m) => (
                                <Button key={m} size="sm" type="button" variant={motivo === m ? 'default' : 'outline'}
                                    onClick={() => setMotivo(m)}>{m}</Button>
                            ))}
                        </div>
                        <Label htmlFor="bandeja-motivo">Motivo</Label>
                        <Textarea id="bandeja-motivo" rows={2} maxLength={200} value={motivo}
                            onChange={(e) => setMotivo(e.target.value)} placeholder="Por qué sale de la bandeja" />
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setCierre(null)} disabled={guardando}>Cancelar</Button>
                        <Button onClick={() => void confirmarCierre()} disabled={guardando || motivo.trim().length < 3}>
                            {guardando && <Loader2 className="h-4 w-4 mr-2 animate-spin" />} Confirmar
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <TipoDeContactoDialog
                schoolId={schoolId}
                conversacionId={marcar?.conversacionId ?? null}
                nombre={marcar?.nombre ?? null}
                tipoInicial={marcar?.tipo ?? 'personal'}
                tambienFamiliaInicial={marcar?.tambienFamilia ?? false}
                abierto={!!marcar}
                onAbiertoChange={(v) => { if (!v) setMarcar(null); }}
                // El BFF cerró sus filas: se recarga para que listas y contadores cuadren.
                onHecho={() => { void cargar(); }}
            />
        </Card>
    );
}
