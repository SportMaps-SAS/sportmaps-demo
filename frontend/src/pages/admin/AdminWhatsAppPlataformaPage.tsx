/**
 * /admin/whatsapp — el canal de WhatsApp de SportMaps (número comercial) para
 * el super admin: conectar el número con el diálogo de Meta, ver su estado,
 * registrar las plantillas de aviso, habilitar escuelas, ver quién activó los
 * avisos y prender o apagar todo. BFF: /api/v1/admin/whatsapp-plataforma
 * (solo admins de plataforma). Spec del canal: docs/specs/canal-whatsapp-plataforma.md.
 */
import { useCallback, useEffect, useState } from 'react';
import { bffClient } from '@/lib/api/bffClient';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toast } from '@/hooks/use-toast';
import { RefreshCw, MessageSquare, Send, Search, Unplug } from 'lucide-react';
import { ConectarNumero, ALTA_CONFIGURADA, type ResultadoDelAlta } from '@/components/whatsapp/ConectarNumero';

const API = '/api/v1/admin/whatsapp-plataforma';

interface EstadoCanal {
    conectado: boolean;
    canal: null | {
        numero: string | null;
        esElComercial: boolean;
        status: string;
        habilitado: boolean;
        porVariable: boolean;
        conectadoAt: string | null;
    };
    meta: null | {
        nombreVerificado: string | null;
        estadoNombre: string | null;
        calidad: string | null;
        enAppBusiness: boolean | null;
        error: string | null;
    };
    plantillas: { nombre: string; categoria: string; cuerpo: string; estadoMeta: string | null; categoriaMeta: string | null; rechazo: string | null }[];
    escuelas: { schoolId: string; nombre: string; habilitado: boolean; suscriptoresActivos: number }[];
    suscriptores: { id: string; escuela: string; numero: string; estado: string; activadaAt: string | null }[];
    auditoria: { accion: string; actor: string | null; detalle: Record<string, unknown>; at: string }[];
}

const ACCIONES: Record<string, string> = {
    conectar: 'Conectó el número',
    desconectar: 'Desconectó el número',
    habilitar_canal: 'Prendió el canal',
    deshabilitar_canal: 'Apagó el canal',
    habilitar_escuela: 'Habilitó una escuela',
    deshabilitar_escuela: 'Deshabilitó una escuela',
    registrar_plantillas: 'Envió plantillas a Meta',
    enviar_prueba: 'Envió una prueba',
};

const fecha = (iso: string | null) => (iso ? new Date(iso).toLocaleString('es-CO', { dateStyle: 'medium', timeStyle: 'short' }) : '—');

function errorDe(e: unknown): string {
    const any = e as any;
    return any?.response?.data?.error || any?.data?.error || any?.message || 'Algo falló';
}

function BadgePlantilla({ estado }: { estado: string | null }) {
    if (!estado) return <Badge variant="outline">Falta en Meta</Badge>;
    if (estado === 'APPROVED') return <Badge className="bg-green-600 hover:bg-green-600">Aprobada</Badge>;
    if (estado === 'REJECTED') return <Badge variant="destructive">Rechazada</Badge>;
    return <Badge variant="secondary">{estado === 'PENDING' ? 'En revisión' : estado}</Badge>;
}

export default function AdminWhatsAppPlataformaPage() {
    const [estado, setEstado] = useState<EstadoCanal | null>(null);
    const [cargando, setCargando] = useState(true);
    const [ocupado, setOcupado] = useState<string | null>(null);
    const [busqueda, setBusqueda] = useState('');
    const [resultados, setResultados] = useState<{ id: string; nombre: string }[]>([]);
    const [numeroPrueba, setNumeroPrueba] = useState('');

    const cargar = useCallback(async () => {
        setCargando(true);
        try {
            setEstado(await bffClient.get<EstadoCanal>(`${API}/estado`));
        } catch (e) {
            toast({ title: 'No se pudo leer el canal', description: errorDe(e), variant: 'destructive' });
        } finally {
            setCargando(false);
        }
    }, []);

    useEffect(() => { void cargar(); }, [cargar]);

    async function accion<T>(clave: string, fn: () => Promise<T>, exito: string): Promise<T | null> {
        setOcupado(clave);
        try {
            const r = await fn();
            toast({ title: exito });
            await cargar();
            return r;
        } catch (e) {
            toast({ title: 'No se pudo', description: errorDe(e), variant: 'destructive' });
            return null;
        } finally {
            setOcupado(null);
        }
    }

    const onConectado = (r: ResultadoDelAlta) => accion('conectar', () => bffClient.post(`${API}/conectar`, {
        code: r.code,
        sesion: r.sesion?.data ? { event: r.sesion.event, ...r.sesion.data } : null,
    }), 'Número conectado');

    async function buscar() {
        try {
            const r = await bffClient.get<{ escuelas: { id: string; nombre: string }[] }>(
                `${API}/escuelas/buscar?q=${encodeURIComponent(busqueda)}`);
            setResultados(r.escuelas);
        } catch (e) {
            toast({ title: 'No se pudo buscar', description: errorDe(e), variant: 'destructive' });
        }
    }

    const c = estado?.canal ?? null;
    const faltanPlantillas = (estado?.plantillas ?? []).some((p) => !p.estadoMeta);

    return (
        <div className="space-y-6">
            <div className="flex items-start justify-between gap-4">
                <div>
                    <h1 className="text-2xl font-bold flex items-center gap-2"><MessageSquare className="h-6 w-6" /> Canal WhatsApp de SportMaps</h1>
                    <p className="text-muted-foreground text-sm">
                        El número comercial avisa a las dueñas de escuela (casos por atender, clases de cortesía, comprobantes, resumen diario).
                    </p>
                </div>
                <Button variant="outline" size="sm" onClick={() => void cargar()} disabled={cargando}>
                    <RefreshCw className={`h-4 w-4 mr-2 ${cargando ? 'animate-spin' : ''}`} /> Actualizar
                </Button>
            </div>

            {/* 1. Número */}
            <Card>
                <CardHeader>
                    <CardTitle>1. Número</CardTitle>
                    <CardDescription>Se conecta con el diálogo oficial de Meta, en modo Coexistence: ventas sigue usando la app de WhatsApp Business.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                    {estado?.conectado && c ? (
                        <>
                            <div className="flex flex-wrap items-center gap-2">
                                <span className="font-medium">+{c.numero}</span>
                                <Badge className="bg-green-600 hover:bg-green-600">Conectado</Badge>
                                {!c.esElComercial && <Badge variant="destructive">No es el comercial (+57 320 268 3539)</Badge>}
                                <span className="text-sm text-muted-foreground">desde {fecha(c.conectadoAt)}</span>
                            </div>
                            {estado.meta && (
                                <p className="text-sm text-muted-foreground">
                                    Meta: {estado.meta.nombreVerificado ?? 's/n'} · nombre {estado.meta.estadoNombre ?? '—'} · calidad {estado.meta.calidad ?? '—'}
                                    {estado.meta.enAppBusiness === true && ' · en la app Business (Coexistence)'}
                                </p>
                            )}
                            {estado.meta?.error && <Alert variant="destructive"><AlertDescription>Meta respondió: {estado.meta.error}</AlertDescription></Alert>}
                            <Button variant="outline" size="sm" disabled={ocupado === 'desconectar'}
                                onClick={() => { if (window.confirm('¿Desconectar el número? Se apagan los avisos y se borra el token.')) void accion('desconectar', () => bffClient.post(`${API}/desconectar`, {}), 'Número desconectado'); }}>
                                <Unplug className="h-4 w-4 mr-2" /> Desconectar
                            </Button>
                        </>
                    ) : ALTA_CONFIGURADA ? (
                        <div className="space-y-2">
                            <p className="text-sm">Inicia sesión con la cuenta de Meta Business que administra el +57 320 268 3539 y elige conectar la cuenta existente.</p>
                            {ocupado === 'conectar' ? <p className="text-sm text-muted-foreground">Conectando…</p> : <ConectarNumero onListo={(r) => void onConectado(r)} />}
                        </div>
                    ) : (
                        <Alert><AlertDescription>El diálogo de Meta no está configurado en este ambiente (faltan VITE_META_APP_ID / VITE_META_ES_CONFIG_ID).</AlertDescription></Alert>
                    )}
                </CardContent>
            </Card>

            {/* 2. Plantillas */}
            <Card>
                <CardHeader>
                    <CardTitle>2. Plantillas de aviso</CardTitle>
                    <CardDescription>Meta las aprueba en minutos u horas. Sin aprobar, solo salen avisos dentro de la ventana de 24 h.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                    <Table>
                        <TableHeader><TableRow><TableHead>Plantilla</TableHead><TableHead>Estado en Meta</TableHead><TableHead className="hidden md:table-cell">Texto</TableHead></TableRow></TableHeader>
                        <TableBody>
                            {(estado?.plantillas ?? []).map((p) => (
                                <TableRow key={p.nombre}>
                                    <TableCell className="font-mono text-xs">{p.nombre}</TableCell>
                                    <TableCell>
                                        <BadgePlantilla estado={p.estadoMeta} />
                                        {p.categoriaMeta && p.categoriaMeta !== 'UTILITY' && <Badge variant="destructive" className="ml-1">{p.categoriaMeta}</Badge>}
                                        {p.rechazo && p.rechazo !== 'NONE' && <div className="text-xs text-destructive mt-1">{p.rechazo}</div>}
                                    </TableCell>
                                    <TableCell className="hidden md:table-cell text-xs text-muted-foreground max-w-md">{p.cuerpo}</TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                    <Button size="sm" disabled={!estado?.conectado || !faltanPlantillas || ocupado === 'plantillas'}
                        onClick={() => void accion('plantillas', () => bffClient.post(`${API}/plantillas`, {}), 'Plantillas enviadas a Meta')}>
                        Enviar a Meta las que faltan
                    </Button>
                </CardContent>
            </Card>

            {/* 3. Escuelas */}
            <Card>
                <CardHeader>
                    <CardTitle>3. Escuelas</CardTitle>
                    <CardDescription>Solo las escuelas habilitadas pueden pedir los avisos. La dueña los activa escribiendo «ACTIVAR» al número de SportMaps.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                    <div className="flex gap-2">
                        <Input placeholder="Buscar escuela por nombre" value={busqueda} onChange={(e) => setBusqueda(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') void buscar(); }} className="max-w-sm" />
                        <Button variant="outline" size="sm" onClick={() => void buscar()}><Search className="h-4 w-4" /></Button>
                    </div>
                    {resultados.length > 0 && (
                        <div className="flex flex-wrap gap-2">
                            {resultados.map((r) => (
                                <Button key={r.id} variant="secondary" size="sm" disabled={ocupado === r.id}
                                    onClick={() => void accion(r.id, () => bffClient.post(`${API}/escuelas/${r.id}`, { habilitado: true }), `${r.nombre} habilitada`).then(() => setResultados([]))}>
                                    + {r.nombre}
                                </Button>
                            ))}
                        </div>
                    )}
                    <Table>
                        <TableHeader><TableRow><TableHead>Escuela</TableHead><TableHead>Suscriptores activos</TableHead><TableHead>Habilitada</TableHead></TableRow></TableHeader>
                        <TableBody>
                            {(estado?.escuelas ?? []).length === 0 && (
                                <TableRow><TableCell colSpan={3} className="text-muted-foreground text-sm">Ninguna escuela habilitada todavía.</TableCell></TableRow>
                            )}
                            {(estado?.escuelas ?? []).map((e) => (
                                <TableRow key={e.schoolId}>
                                    <TableCell>{e.nombre}</TableCell>
                                    <TableCell>{e.suscriptoresActivos}</TableCell>
                                    <TableCell>
                                        <Switch checked={e.habilitado} disabled={ocupado === e.schoolId}
                                            onCheckedChange={(v) => void accion(e.schoolId, () => bffClient.post(`${API}/escuelas/${e.schoolId}`, { habilitado: v }), v ? 'Escuela habilitada' : 'Escuela deshabilitada')} />
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </CardContent>
            </Card>

            {/* 4. Suscriptores */}
            <Card>
                <CardHeader>
                    <CardTitle>4. Quién recibe los avisos</CardTitle>
                    <CardDescription>Cada número se activa solo, escribiendo «ACTIVAR» desde ese celular (así queda su consentimiento).</CardDescription>
                </CardHeader>
                <CardContent>
                    <Table>
                        <TableHeader><TableRow><TableHead>Escuela</TableHead><TableHead>Número</TableHead><TableHead>Estado</TableHead><TableHead>Activo desde</TableHead></TableRow></TableHeader>
                        <TableBody>
                            {(estado?.suscriptores ?? []).length === 0 && (
                                <TableRow><TableCell colSpan={4} className="text-muted-foreground text-sm">Nadie ha activado los avisos todavía.</TableCell></TableRow>
                            )}
                            {(estado?.suscriptores ?? []).map((s) => (
                                <TableRow key={s.id}>
                                    <TableCell>{s.escuela}</TableCell>
                                    <TableCell className="font-mono">{s.numero}</TableCell>
                                    <TableCell>{s.estado === 'activa' ? <Badge className="bg-green-600 hover:bg-green-600">Activa</Badge> : <Badge variant="secondary">Pendiente</Badge>}</TableCell>
                                    <TableCell className="text-sm">{fecha(s.activadaAt)}</TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </CardContent>
            </Card>

            {/* 5. Interruptor y prueba */}
            <Card>
                <CardHeader>
                    <CardTitle>5. Encender el canal</CardTitle>
                    <CardDescription>Apagado, no sale ningún aviso ni se atiende «ACTIVAR».</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="flex items-center gap-3">
                        <Switch checked={Boolean(c?.habilitado || c?.porVariable)} disabled={!estado?.conectado || c?.porVariable || ocupado === 'interruptor'}
                            onCheckedChange={(v) => void accion('interruptor', () => bffClient.post(`${API}/interruptor`, { habilitado: v }), v ? 'Canal encendido' : 'Canal apagado')} />
                        <span className="text-sm">{c?.habilitado || c?.porVariable ? 'Encendido' : 'Apagado'}</span>
                        {c?.porVariable && <span className="text-xs text-muted-foreground">(lo prende la variable PLATFORM_WA_ENABLED de Render)</span>}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        <Input placeholder="Celular para la prueba (3001234567)" value={numeroPrueba} onChange={(e) => setNumeroPrueba(e.target.value)} className="max-w-xs" />
                        <Button size="sm" variant="outline" disabled={!estado?.conectado || !numeroPrueba || ocupado === 'prueba'}
                            onClick={() => void accion('prueba', () => bffClient.post(`${API}/prueba`, { numero: numeroPrueba }), 'Prueba enviada')}>
                            <Send className="h-4 w-4 mr-2" /> Enviar prueba
                        </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">La prueba es texto libre: solo llega si ese celular le escribió al número de SportMaps en las últimas 24 h.</p>
                </CardContent>
            </Card>

            {/* Historial */}
            <Card>
                <CardHeader><CardTitle>Historial de cambios</CardTitle></CardHeader>
                <CardContent>
                    {(estado?.auditoria ?? []).length === 0 ? <p className="text-sm text-muted-foreground">Sin cambios todavía.</p> : (
                        <ul className="space-y-1 text-sm">
                            {(estado?.auditoria ?? []).map((a, i) => (
                                <li key={i}><span className="text-muted-foreground">{fecha(a.at)}</span> · {a.actor ?? 'Alguien'} · {ACCIONES[a.accion] ?? a.accion}
                                    {typeof a.detalle?.escuela === 'string' && ` (${a.detalle.escuela})`}</li>
                            ))}
                        </ul>
                    )}
                </CardContent>
            </Card>
        </div>
    );
}
